// PR #142 review F-003 / F-009 / F-015: every upstream-controlled buffer in
// the desktop external client is bounded in BYTES, the 2xx chunk queue applies
// backpressure, and a non-2xx error body has its own short timer.
//   F-003 caps (shared with the browser app): SSE line or frame 1 MiB,
//         non-stream completion 8 MiB, model listing 4 MiB per page, error
//         body 64 KiB. Past a cap the request is aborted with a classified
//         'server' ExternalProviderError (the error-body cap instead ends the
//         read and classifies by status).
//   F-009 the 2xx queue pauses the socket while the consumer is slow.
//   F-015 a stalled error body times out on its own bound, not the 10-minute
//         first-byte budget.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_BODY_LIMIT_BYTES,
  ERROR_BODY_TIMEOUT_MS,
  guardedRequest,
  MAX_COMPLETION_BODY_BYTES,
  MAX_MODEL_LIST_BYTES,
  MAX_SSE_LINE_BYTES,
  MAX_STREAMED_ANSWER_BYTES,
  RESPONSE_QUEUE_HIGH_WATER_BYTES,
} from '../../main/backend/net/guarded-request';
import { ExternalProviderError } from '../../main/backend/net/provider-error';
import { generateExternal, listExternalModels, type ExternalProtocol } from '../../main/backend/inference/external-generator';

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

interface Upstream {
  base: string;
  /** Resolves when the client side of the upstream connection is gone. */
  closed: () => boolean;
}

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  let closed = false;
  const s = http.createServer((req, res) => {
    req.resume();
    req.socket.on('close', () => {
      closed = true;
    });
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, closed: () => closed };
}

async function failureOf(p: Promise<unknown>): Promise<ExternalProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ExternalProviderError);
    return err as ExternalProviderError;
  }
  throw new Error('expected a failure');
}

const SENTINEL_MS = 8_000;
function bounded<T>(p: Promise<T>): Promise<T | 'sentinel'> {
  return Promise.race([p, new Promise<'sentinel'>((resolve) => setTimeout(() => resolve('sentinel'), SENTINEL_MS))]);
}

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

const gen = (protocol: ExternalProtocol, base: string) =>
  generateExternal({
    config: { protocol, baseUrl: base, model: 'm1', apiKey: null },
    question: 'q',
    contextTexts: null,
    airgap: false,
  });

describe('F-003: byte caps (values shared with the browser app)', () => {
  it('pins the cap values', () => {
    expect(MAX_SSE_LINE_BYTES).toBe(1024 * 1024);
    expect(MAX_COMPLETION_BODY_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_MODEL_LIST_BYTES).toBe(4 * 1024 * 1024);
    expect(ERROR_BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect(MAX_STREAMED_ANSWER_BYTES).toBe(8 * 1024 * 1024);
  });

  it('text(maxBytes) aborts past the cap with a classified server error', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5000));
    });
    const response = await guardedRequest({ url: `${up.base}/x`, method: 'GET', headers: {}, ctx: { origin: up.base }, airgap: false });
    const err = await failureOf(response.text(1000, 'a test body'));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/a test body larger than 1000 bytes/);
  });

  it('a non-stream completion body over 8 MiB is refused before JSON.parse', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const filler = 'a'.repeat(MAX_COMPLETION_BODY_BYTES + 1024);
      res.end(`{"choices":[{"message":{"content":"${filler}"}}]}`);
    });
    const err = await failureOf(gen('openai', up.base));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/completion body larger than 8388608 bytes/);
  }, 20_000);

  it('an OpenAI SSE line over 1 MiB (no newline) is refused and the request aborted', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // keeps writing one endless line; never ends on its own
      const chunk = 'b'.repeat(64 * 1024);
      let sent = 0;
      const pump = (): void => {
        while (sent < 4 * MAX_SSE_LINE_BYTES) {
          sent += chunk.length;
          if (!res.write(sent === chunk.length ? `data: ${chunk}` : chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    const result = await bounded(failureOf(gen('openai', up.base)));
    expect(result).not.toBe('sentinel');
    const err = result as ExternalProviderError;
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/stream line larger than 1048576 bytes/);
    expect(await waitFor(up.closed, 2_000)).toBe(true);
  }, 20_000);

  it('an Anthropic SSE frame over 1 MiB (many short data lines, no blank line) is refused', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const line = `data: ${'c'.repeat(16 * 1024)}\n`;
      let sent = 0;
      const pump = (): void => {
        while (sent < 4 * MAX_SSE_LINE_BYTES) {
          sent += line.length;
          if (!res.write(line)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    const result = await bounded(failureOf(gen('anthropic', up.base)));
    expect(result).not.toBe('sentinel');
    const err = result as ExternalProviderError;
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/stream frame larger than 1048576 bytes/);
  }, 20_000);

  it('a model-list page over 4 MiB is refused before JSON.parse', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"data":[{"id":"${'d'.repeat(MAX_MODEL_LIST_BYTES + 1024)}"}]}`);
    });
    const err = await failureOf(
      listExternalModels({ config: { protocol: 'openai', baseUrl: up.base, model: 'm', apiKey: null }, airgap: false }),
    );
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/model list larger than 4194304 bytes/);
  }, 20_000);

  it('the 4 MiB model-list budget is shared across Anthropic pages (pagination cannot multiply it)', async () => {
    let pages = 0;
    const up = await upstream((_req, res) => {
      pages += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      // each page alone is under the cap; two of them are not
      const id = `${'p'.repeat(3 * 1024 * 1024)}${pages}`;
      res.end(JSON.stringify({ data: [{ id }], has_more: true, last_id: `last-${pages}` }));
    });
    const err = await failureOf(
      listExternalModels({ config: { protocol: 'anthropic', baseUrl: up.base, model: 'm', apiKey: null }, airgap: false }),
    );
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/model list larger than 4194304 bytes/);
    expect(pages).toBe(2);
  }, 20_000);

  it('an oversized 401 / 404 error body is truncated, not raised: still classified auth / model', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [404, 'model'],
    ] as const) {
      const up = await upstream((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`denied ${'f'.repeat(ERROR_BODY_LIMIT_BYTES * 2)}`);
      });
      const err = await failureOf(
        guardedRequest({ url: `${up.base}/x`, method: 'GET', headers: {}, ctx: { origin: up.base, model: 'm' }, airgap: false }),
      );
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.message).toContain('denied');
    }
  }, 20_000);

  it('an endless non-2xx error body is cut at 64 KiB: the request ends at once, classified by status', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.write('e'.repeat(ERROR_BODY_LIMIT_BYTES + 4096));
      // ...and never ends
    });
    const started = Date.now();
    const result = await bounded(
      failureOf(guardedRequest({ url: `${up.base}/x`, method: 'GET', headers: {}, ctx: { origin: up.base }, airgap: false })),
    );
    expect(result).not.toBe('sentinel');
    const err = result as ExternalProviderError;
    expect(err.kind).toBe('server');
    expect(err.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitFor(up.closed, 2_000)).toBe(true);
  }, 20_000);
});

describe('F-003 (closeout): the streamed answer as a whole is capped in UTF-8 bytes', () => {
  // 1024 x '€' = 1024 characters but 3072 UTF-8 bytes per delta. 4096 deltas
  // = 12 MiB of answer bytes yet only 4 Mi characters, so a cap that counted
  // characters against 8 Mi would never trip and the stream would finish OK.
  const DELTA = '€'.repeat(1024);
  const DELTA_BYTES = Buffer.byteLength(DELTA);
  const FRAMES = 4096;

  const frameFor = (protocol: ExternalProtocol): string =>
    protocol === 'openai'
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: DELTA } }] })}\n\n`
      : `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: DELTA } })}\n\n`;
  const endFor = (protocol: ExternalProtocol): string =>
    protocol === 'openai' ? 'data: [DONE]\n\n' : `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}: a stream of more than 8 MiB is cut at the cap, errors, and aborts the request`, async () => {
      const up = await upstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = frameFor(protocol);
        let sent = 0;
        const pump = (): void => {
          while (sent < FRAMES) {
            sent += 1;
            if (!res.write(frame)) {
              res.once('drain', pump);
              return;
            }
          }
          // A well-formed end: without the cap the generation SUCCEEDS.
          res.end(endFor(protocol));
        };
        pump();
      });
      let emittedBytes = 0;
      const result = await bounded(
        failureOf(
          generateExternal({
            config: { protocol, baseUrl: up.base, model: 'm1', apiKey: null },
            question: 'q',
            contextTexts: null,
            airgap: false,
            streamCallback: (text) => {
              emittedBytes += Buffer.byteLength(text);
            },
          }),
        ),
      );
      expect(result).not.toBe('sentinel');
      const err = result as ExternalProviderError;
      expect(err.kind).toBe('server');
      expect(err.message).toMatch(/an answer larger than 8388608 bytes/);
      // What the user saw stays: at most the cap, and within one delta of it.
      expect(emittedBytes).toBeLessThanOrEqual(MAX_STREAMED_ANSWER_BYTES);
      expect(emittedBytes).toBeGreaterThan(MAX_STREAMED_ANSWER_BYTES - DELTA_BYTES);
      expect(await waitFor(up.closed, 2_000)).toBe(true);
    }, 30_000);
  }
});

describe('F-015: the error body has its own short timer', () => {
  it('defaults to 15 s', () => {
    expect(ERROR_BODY_TIMEOUT_MS).toBe(15_000);
  });

  it('a stalled error body times out on errorBodyTimeoutMs even with a long first-byte budget', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.write('partial');
      // stalls forever
    });
    const started = Date.now();
    const result = await bounded(
      failureOf(
        guardedRequest({
          url: `${up.base}/x`,
          method: 'GET',
          headers: {},
          ctx: { origin: up.base },
          airgap: false,
          firstByteTimeoutMs: 60_000,
          errorBodyTimeoutMs: 400,
        }),
      ),
    );
    const elapsed = Date.now() - started;
    expect(result).not.toBe('sentinel');
    expect((result as ExternalProviderError).kind).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});

describe('F-009: the 2xx chunk queue applies backpressure', () => {
  it('a consumer that does not read pauses the socket instead of buffering the whole body', async () => {
    const TOTAL = 64 * 1024 * 1024;
    let written = 0;
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = (): void => {
        while (written < TOTAL) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const response = await guardedRequest({ url: `${up.base}/x`, method: 'GET', headers: {}, ctx: { origin: up.base }, airgap: false });
    // Do not consume for a while: only backpressure keeps the sender back.
    await new Promise((r) => setTimeout(r, 1_000));
    const whileIdle = written;
    // queue cap + socket/kernel buffers; without the pause all 64 MiB arrive.
    expect(whileIdle).toBeLessThan(RESPONSE_QUEUE_HIGH_WATER_BYTES + 16 * 1024 * 1024);
    // Draining resumes the stream: the whole body still arrives intact.
    let total = 0;
    for await (const part of response.chunks()) total += Buffer.byteLength(part);
    expect(total).toBe(TOTAL);
  }, 30_000);
});
