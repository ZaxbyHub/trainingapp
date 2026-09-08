// B3 spec (issue #61): the guarded listener's contract details that the
// frozen acceptance checks exercise end-to-end but unit specs must pin —
// the GUARD SPY (every request traverses the gate exactly once BEFORE any
// handler; the Phase 4.2 guardrail), SSE client-disconnect cancellation,
// sidecar-proxy header treatment (X-Desktop-Token stripped, X-Profile-Id
// preserved), OPTIONS answered only AFTER the guard, and the settings
// cross-field rule.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo, ServerResponse } from 'node:http';
import { createBackendServer, listenOnRandomPort, runAskStream } from '../../main/backend/server';
import { StubEngine } from '../../main/backend/engine';
import { createLoopbackGuard } from '../../main/security/loopback-guard';

const TOKEN = 'b3-server-spec-token';
const TOKEN_HEADER = 'x-desktop-token';

let server: http.Server;
let port: number;
let guardCalls = 0;
let engine: StubEngine;

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function guardedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [TOKEN_HEADER]: TOKEN, ...extra };
}

beforeAll(async () => {
  engine = new StubEngine();
  const realGuard = createLoopbackGuard({ token: TOKEN });
  const spyGuard = (request: Parameters<typeof realGuard>[0]) => {
    guardCalls += 1;
    return realGuard(request);
  };
  server = createBackendServer({ guard: spyGuard, tokenHeaderName: 'X-Desktop-Token', engine });
  port = await listenOnRandomPort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('b3-server: guard spy (the trust-boundary guardrail)', () => {
  it('EVERY request traverses the guard exactly once before any handler', async () => {
    guardCalls = 0;
    const ok = await fetch(url('/health'), { headers: guardedHeaders() });
    expect(ok.status).toBe(200);
    const unauthorized = await fetch(url('/health'));
    expect(unauthorized.status).toBe(401);
    const wrongOrigin = await fetch(url('/health'), {
      headers: { ...guardedHeaders(), origin: 'http://evil.example' },
    });
    expect(wrongOrigin.status).toBe(403);
    const unknown = await fetch(url('/definitely-not-a-route'), { headers: guardedHeaders() });
    expect(unknown.status).toBe(404);
    expect(guardCalls).toBe(4);
  });

  it('an unauthorized /ask never reaches the engine', async () => {
    const querySpy = vi.spyOn(engine, 'query');
    const response = await fetch(url('/ask'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'should never arrive' }),
    });
    expect(response.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });
});

describe('b3-server: SSE cancellation semantics', () => {
  function recordingResponse(): { res: ServerResponse; writes: string[]; ended: () => boolean } {
    const writes: string[] = [];
    let ended = false;
    const res = new http.ServerResponse({ method: 'POST', headers: {} } as never) as ServerResponse & { write: unknown; end: unknown };
    res.writeHead = (() => res) as never;
    (res as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    (res as unknown as { end: (chunk?: string) => void }).end = (chunk?: string) => {
      if (chunk !== undefined) writes.push(chunk);
      ended = true;
    };
    // 'on' exists on the real ServerResponse (EventEmitter); the double keeps it.
    return { res, writes, ended: () => ended };
  }

  it('client disconnect mid-stream emits exactly ONE terminal done{cancelled:true,...} then closes', async () => {
    const { res, writes, ended } = recordingResponse();
    const promise = runAskStream(res as ServerResponse, engine, 'cancel me', {}, undefined);
    // Let the first token land, then the client goes away.
    await new Promise((resolve) => setTimeout(resolve, 5));
    (res as unknown as ServerResponse).emit('close');
    await promise;
    const payloads = writes.map((frame) => JSON.parse(frame.replace(/^data: /, '').replace(/\r\n$/, '')));
    const terminals = payloads.filter((p) => 'done' in p || 'error' in p);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ done: true, cancelled: true });
    expect('sources' in terminals[0]).toBe(true);
    expect('context_length' in terminals[0]).toBe(true);
    expect(ended()).toBe(true);
  });

  it('happy path: >=1 token payload and exactly ONE done terminal with sources+context_length, CRLF frames', async () => {
    const response = await fetch(url('/ask/stream'), {
      method: 'POST',
      headers: { ...guardedHeaders(), 'content-type': 'application/json', authorization: 'Bearer ignored' },
      body: JSON.stringify({ question: 'hello', history: [{ role: 'user', content: 'hi' }], n_results: 3 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const raw = await response.text();
    expect(raw.includes('\r\n\r\n')).toBe(true);
    const payloads = raw
      .split('\r\n\r\n')
      .filter((block) => block.length > 0)
      .map((block) => JSON.parse(block.replace(/^data: /, '')));
    const tokens = payloads.filter((p) => 'token' in p);
    const terminals = payloads.filter((p) => 'done' in p || 'error' in p);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ done: true });
    expect('sources' in terminals[0]).toBe(true);
    expect('context_length' in terminals[0]).toBe(true);
  });
});

describe('b3-server: sidecar proxy header treatment', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamSeen: { headers: Record<string, unknown>; path?: string };

  beforeAll(async () => {
    upstreamSeen = { headers: {} };
    upstream = http.createServer((req, res) => {
      upstreamSeen = { headers: { ...req.headers }, path: req.url };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ proxied: true, path: req.url }));
    });
    upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as AddressInfo).port));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function withProxyServer(fn: (proxyPort: number) => Promise<void>): Promise<void> {
    const proxy = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      upstreamPort,
    });
    const proxyPort = await listenOnRandomPort(proxy);
    try {
      await fn(proxyPort);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }

  it('strips the transport token, FORWARDS X-Profile-Id, and passes the response through', async () => {
    await withProxyServer(async (proxyPort) => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/documents`, {
        headers: { [TOKEN_HEADER]: TOKEN, 'X-Profile-Id': 'abc12345' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { proxied: boolean; path: string };
      expect(body.proxied).toBe(true);
      expect(body.path).toBe('/documents');
      expect(upstreamSeen.headers[TOKEN_HEADER]).toBeUndefined();
      expect(upstreamSeen.headers['x-profile-id']).toBe('abc12345');
    });
  });

  it('the guard still gates proxied requests (no token -> 401, never forwarded)', async () => {
    await withProxyServer(async (proxyPort) => {
      upstreamSeen = { headers: {} };
      const response = await fetch(`http://127.0.0.1:${proxyPort}/documents`);
      expect(response.status).toBe(401);
      expect(upstreamSeen.path).toBeUndefined();
    });
  });
});

describe('b3-server: preflight and settings guards', () => {
  it('OPTIONS is answered only AFTER the guard: no token -> 401, allowed origin + token -> 204 with CORS echo', async () => {
    const denied = await fetch(url('/ask'), { method: 'OPTIONS', headers: { origin: 'app://index.html' } });
    expect(denied.status).toBe(401);
    const allowed = await fetch(url('/ask'), {
      method: 'OPTIONS',
      headers: {
        origin: 'app://index.html',
        'access-control-request-headers': 'content-type, x-desktop-token',
        [TOKEN_HEADER]: TOKEN,
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('app://index.html');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('x-desktop-token');
  });

  it('PUT /settings: cross-field overlap>=size -> 400; out-of-bounds -> 422; valid patch -> 200', async () => {
    const bad = await fetch(url('/settings'), {
      method: 'PUT',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ rag_chunk_overlap: 5000 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toBe('rag_chunk_overlap must be less than rag_chunk_size');
    const invalid = await fetch(url('/settings'), {
      method: 'PUT',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ rag_n_results: 99 }),
    });
    expect(invalid.status).toBe(422);
    const good = await fetch(url('/settings'), {
      method: 'PUT',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ rag_n_results: 5 }),
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { n_results: number }).n_results).toBe(5);
  });

  it('validation and method surfaces: empty question 422, wrong method 405, known-route auth covers /auth/* too', async () => {
    const empty = await fetch(url('/ask'), {
      method: 'POST',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ question: '   ' }),
    });
    expect(empty.status).toBe(422);
    const wrongMethod = await fetch(url('/health'), { method: 'POST', headers: guardedHeaders() });
    expect(wrongMethod.status).toBe(405);
    const authStatus = await fetch(url('/auth/status'), { headers: guardedHeaders() });
    expect(authStatus.status).toBe(200);
    const authBody = (await authStatus.json()) as { enabled: boolean; methods: string[] };
    expect(authBody.enabled).toBe(false);
    const token = await fetch(url('/auth/token'), {
      method: 'POST',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ api_key: 'definitely-wrong' }),
    });
    expect(token.status).toBe(503);
  });
});
