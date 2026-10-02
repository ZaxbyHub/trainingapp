// PR #142 review F-002: POST /settings/external/test is bounded in total and
// stops when the client goes away.
//   - one aggregate deadline covers the whole connection test: a slow-drip
//     model list (whose idle timer re-arms on every chunk) and a slow
//     Anthropic pagination chain are both cut off at the deadline — and not
//     before it (lower bound, so a probe that returns at once cannot pass);
//   - a client that disconnects mid-probe aborts the upstream request.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { PROBE_TOTAL_TIMEOUT_MS } from '../../main/backend/inference/external-generator';

const TOKEN = 'probe-bounds-token';
const servers: http.Server[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(async () => {
  while (timers.length > 0) clearInterval(timers.pop());
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return (s.address() as AddressInfo).port;
}

function engineWith(extra: Record<string, unknown> = {}) {
  return new LlamaEngine({
    modelDir: 'unused-model-dir',
    llamaFactory: vi.fn(async () => {
      throw new Error('local model must not load');
    }),
    externalProvider: extra,
  });
}

const SENTINEL_MS = 8_000;
async function bounded<T>(p: Promise<T>): Promise<T | 'sentinel'> {
  return Promise.race([p, new Promise<'sentinel'>((resolve) => setTimeout(() => resolve('sentinel'), SENTINEL_MS))]);
}

describe('F-002: the connection test has an aggregate deadline', () => {
  it('defaults to 30 s', () => {
    expect(PROBE_TOTAL_TIMEOUT_MS).toBe(30_000);
  });

  it('a slow-drip model list (idle timer re-armed by every byte) is stopped at the total deadline, not before', async () => {
    const port = await listen(
      http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":[');
        const t = setInterval(() => res.write(' '), 40);
        timers.push(t);
        res.on('close', () => clearInterval(t));
      }),
    );
    const engine = engineWith({ probeTimeoutMs: 700 });
    const started = Date.now();
    const result = await bounded(engine.probeExternal({ protocol: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm1' }));
    const elapsed = Date.now() - started;
    expect(result).not.toBe('sentinel');
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    expect((result as { message: string }).message).toMatch(/in total/);
    expect(elapsed).toBeGreaterThanOrEqual(650);
    expect(elapsed).toBeLessThan(SENTINEL_MS);
  }, 15_000);

  it('a slow Anthropic pagination chain (has_more forever) is stopped at the total deadline, not before', async () => {
    let pages = 0;
    const port = await listen(
      http.createServer((req, res) => {
        req.resume();
        pages += 1;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: `m${pages}` }], has_more: true, last_id: `m${pages}` }));
        }, 150);
      }),
    );
    const engine = engineWith({ probeTimeoutMs: 800 });
    const started = Date.now();
    const result = await bounded(engine.probeExternal({ protocol: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'm1' }));
    const elapsed = Date.now() - started;
    expect(result).not.toBe('sentinel');
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(750);
    // 50 pages x 150 ms would take 7.5 s; the deadline stopped the chain early.
    expect(pages).toBeLessThan(15);
  }, 15_000);
});

describe('F-002: a client disconnect aborts the upstream request', () => {
  it('closing the probe request closes the upstream connection long before any timeout', async () => {
    let upstreamGotRequest = false;
    let upstreamClosed = false;
    const upstreamPort = await listen(
      http.createServer((req) => {
        req.resume();
        upstreamGotRequest = true;
        req.socket.on('close', () => {
          upstreamClosed = true;
        });
        // never answers: only the 15 s first-byte timer or an abort ends it
      }),
    );
    const backend = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: engineWith(),
    });
    const port = await listenOnRandomPort(backend);
    servers.push(backend);

    const body = JSON.stringify({ protocol: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}`, model: 'm1' });
    const client = http.request({
      host: '127.0.0.1',
      port,
      path: '/settings/external/test',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN, 'content-length': Buffer.byteLength(body) },
    });
    client.on('error', () => {
      /* destroyed on purpose */
    });
    client.end(body);
    const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return cond();
    };
    expect(await waitFor(() => upstreamGotRequest, 5_000)).toBe(true);
    expect(upstreamClosed).toBe(false);
    client.destroy();
    // Without the abort the upstream socket stays open until the 15 s
    // first-byte timer (or the 30 s total deadline).
    expect(await waitFor(() => upstreamClosed, 2_000)).toBe(true);
  }, 15_000);
});
