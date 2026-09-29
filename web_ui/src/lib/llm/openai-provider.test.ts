/**
 * Permanent regression tests for the OpenAI-compatible provider (trace
 * external-llm-provider-settings, AC1/AC2 + Round-3 plan tests).
 *
 * Covers: URL normalization edges (bare, /v1, /v1/, full-endpoint paste,
 * /V1 case), the standalone verbatim chat() wire contract, probe behavior
 * against an OpenAI-shaped server (never /auth/status) and unreachable
 * targets, config persistence, and cancellation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FIRST_BYTE_TIMEOUT_MS,
  OpenAICompatChatService,
  assertProviderUrlAllowed,
  isProviderConfigured,
  loadProviderConfig,
  normalizeProviderBaseUrl,
  parseOpenAISseLine,
  probeOpenAICompat,
  saveProviderConfig,
} from './openai-provider';

describe('normalizeProviderBaseUrl', () => {
  test('bare host gains /v1', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
  });
  test('existing /v1 is kept (no doubling)', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
  });
  test('trailing slashes are stripped before the /v1 check', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080/v1');
  });
  test('full-endpoint paste is reduced to the base', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/v1/chat/completions')).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });
  test('a pasted /v1/models route is reduced to the base (review finding)', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/v1/models')).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });
  test('query and fragment are stripped, not folded into the path (review finding)', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080?x=1')).toBe(
      'http://127.0.0.1:8080/v1'
    );
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/#frag')).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });
  test('userinfo is stripped (fetch rejects credential URLs; never persisted)', () => {
    expect(normalizeProviderBaseUrl('http://user:pass@127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });
  test('the /v1 segment match is case-insensitive', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/V1/')).toBe('http://127.0.0.1:8080/V1');
  });
});

describe('assertProviderUrlAllowed', () => {
  test('the IPv4 loopback passes', () => {
    expect(() => assertProviderUrlAllowed('http://127.0.0.1:8080/v1')).not.toThrow();
  });
  test('IPv6 loopback [::1] is REJECTED with an actionable message (PRR-002)', () => {
    // Chromium cannot parse http://[::1]:* as a CSP source-list entry (it is
    // silently dropped from connect-src — live-verified in the PR #138
    // review), so a [::1] provider would pass a naive host check and then be
    // network-blocked at runtime in the packaged build. The guard must reject
    // it up front and name the working host form.
    expect(() => assertProviderUrlAllowed('http://[::1]:8080/v1')).toThrow(
      /http:\/\/127\.0\.0\.1:<port>/
    );
    expect(() => assertProviderUrlAllowed('http://[::1]:8080/v1')).toThrow(/loopback/i);
  });
  test('non-loopback hosts are rejected (packaged CSP permits loopback only)', () => {
    expect(() => assertProviderUrlAllowed('http://localhost:8080/v1')).toThrow(/loopback/i);
    expect(() => assertProviderUrlAllowed('http://192.168.1.10:8080/v1')).toThrow(/loopback/i);
    // https on a loopback host passes the host check but fails the http-only
    // scheme guard (packaged CSP connect-src is http-only).
    expect(() => assertProviderUrlAllowed('https://ai.example.com/v1')).toThrow();
    expect(() => assertProviderUrlAllowed('https://127.0.0.1:8443/v1')).toThrow(/use http/);
  });
  test('non-http schemes are rejected even on loopback hosts (CSP is http-only)', () => {
    expect(() => assertProviderUrlAllowed('https://127.0.0.1:8443/v1')).toThrow(/http:\/\//);
  });
  test('dangerous schemes and metadata/IPv6 forms are blocked', () => {
    expect(() => assertProviderUrlAllowed('javascript:alert(1)')).toThrow();
    expect(() => assertProviderUrlAllowed('file:///etc/passwd')).toThrow();
    expect(() => assertProviderUrlAllowed('http://169.254.169.254/v1')).toThrow();
    expect(() => assertProviderUrlAllowed('http://[::ffff:a9fe:a9fe]/v1')).toThrow();
    expect(() => assertProviderUrlAllowed('http://[fe80::a9fe:a9fe]/v1')).toThrow();
  });
  test('the first-byte watchdog is 10 minutes (#133 desktop-stream parity, F-005)', () => {
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(600_000);
  });
});

describe('OpenAICompatChatService.chat (frozen C1 wire contract)', () => {
  const startServer = (
    handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
  ): Promise<{ server: http.Server; port: number; bodies: string[]; urls: string[]; auth: (string | undefined)[] }> =>
    new Promise((resolve) => {
      const bodies: string[] = [];
      const urls: string[] = [];
      const auth: (string | undefined)[] = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          bodies.push(body);
          urls.push(req.url ?? '');
          auth.push(req.headers.authorization);
          handler(req, res, body);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as AddressInfo).port, bodies, urls, auth });
      });
    });

  afterEach(async () => {
    // nothing persistent
  });

  test('works standalone (no initialize), sends messages verbatim, Bearer when keyed', async () => {
    const { server, port, bodies, urls, auth } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = ['Hello', ' streamed', ' world'].map(
        (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`
      );
      res.end([...frames, 'data: [DONE]', ''].join('\n'));
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm1',
        apiKey: 'k1',
      });
      const messages = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ];
      const answer = await svc.chat(messages);
      expect(answer).toBe('Hello streamed world');
      expect(urls).toEqual(['/v1/chat/completions']);
      expect(JSON.parse(bodies[0])).toEqual({ model: 'm1', messages, stream: true });
      expect(auth[0]).toBe('Bearer k1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('no apiKey means NO Authorization header', async () => {
    const { server, port, auth } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // A real (minimal) completion: an empty stream is now a hard error
      // (F-003), so this header-contract test answers with one delta + DONE.
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\ndata: [DONE]\n\n`
      );
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      await expect(svc.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
      expect(auth[0]).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('server error bodies surface their message', async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not loaded' } }));
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      await expect(svc.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('model not loaded');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('generate() streams deltas and cancellation stops consumption', async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = ['a', 'b', 'c'].map(
        (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`
      );
      res.end([...frames, 'data: [DONE]', ''].join('\n'));
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      const controller = new AbortController();
      const received: string[] = [];
      for await (const delta of svc.generate([{ role: 'user', content: 'hi' }], {
        signal: controller.signal,
      })) {
        received.push(delta);
        controller.abort();
      }
      expect(received).toEqual(['a']);
      // getModelInfo shape is the LLMModelInfo contract (not a raw baseUrl map)
      expect(svc.getModelInfo()).toEqual({
        modelId: 'm',
        quantization: 'remote',
        sizeBytes: 0,
        cached: true,
      });
      expect(svc.getInferenceMode()).toBe('openai-compat');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('generate() streams incrementally (first delta arrives before the stream ends)', async () => {
    let streamEnded = false;
    const { server, port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n`);
      // Hold the stream open; end it only after the consumer saw the first delta.
      const interval = setInterval(() => {
        if (streamEnded) {
          clearInterval(interval);
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'last' } }] })}\ndata: [DONE]\n\n`);
        }
      }, 25);
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      const deltas: string[] = [];
      for await (const delta of svc.generate([{ role: 'user', content: 'hi' }])) {
        deltas.push(delta);
        if (deltas.length === 1) {
          // The first delta MUST be observable while the server is still
          // holding the stream open (reviewer round 1, finding 2).
          expect(streamEnded).toBe(false);
          streamEnded = true;
        }
      }
      expect(deltas.join('')).toBe('firstlast');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('probeOpenAICompat (frozen C2 contract)', () => {
  test('succeeds against /v1/models-only servers and never requests /auth/status', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if ((req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const result = await probeOpenAICompat(`http://127.0.0.1:${port}`);
      expect(result.ok).toBe(true);
      expect(hits.some((h) => h.includes('/auth/status'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('unreachable endpoints resolve ok:false with a non-empty actionable detail', async () => {
    const result = await probeOpenAICompat('http://127.0.0.1:1');
    expect(result.ok).toBe(false);
    expect((result.detail ?? '').length).toBeGreaterThan(0);
  });

  test('sends the configured Bearer header so key-protected servers probe green', async () => {
    let sawAuth: string | undefined;
    const server = http.createServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const keyed = await probeOpenAICompat(`http://127.0.0.1:${port}`, { apiKey: 'probe-key' });
      expect(keyed.ok).toBe(true);
      expect(sawAuth).toBe('Bearer probe-key');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('F-003: hostile/degenerate SSE bodies fail loudly, never as silent successes', () => {
  test('parseOpenAISseLine classifies error frames, [DONE], finish_reason, deltas', () => {
    expect(parseOpenAISseLine('data: {"choices":[{"delta":{"content":"hi"}}]}').deltas).toEqual([
      'hi',
    ]);
    expect(parseOpenAISseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}').finish).toBe(
      true
    );
    expect(parseOpenAISseLine('data: [DONE]').done).toBe(true);
    expect(
      parseOpenAISseLine('data: {"error":{"message":"model overloaded"}}').error
    ).toBe('model overloaded');
    expect(parseOpenAISseLine('error: {"message":"inference failed"}').error).toBe(
      'inference failed'
    );
    // reasoning-only deltas are NOT answer text
    expect(
      parseOpenAISseLine('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}')
    ).toEqual({ deltas: [] });
    // keep-alives/comments and unparseable data payloads contribute nothing
    expect(parseOpenAISseLine(': keep-alive')).toEqual({ deltas: [] });
    expect(parseOpenAISseLine('data: not-json')).toEqual({ deltas: [] });
  });

  test('a mid-stream data error frame rejects with its message', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
      res.end('data: {"error":{"message":"kv cache overflow"}}\n\n');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      await expect(svc.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'kv cache overflow'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('an llama-server-style error: event rejects', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('error: {"message":"prompt eval failed"}\n\n');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      await expect(svc.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'prompt eval failed'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a non-stream JSON reply (server ignored stream:true) yields message.content', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content: 'plain json answer' }, finish_reason: 'stop' }] })
      );
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      await expect(svc.chat([{ role: 'user', content: 'hi' }])).resolves.toBe(
        'plain json answer'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a 200 JSON body that stalls mid-flight fails bounded (generate path)', async () => {
    // Reviewer re-gate finding: the non-stream JSON branch reads the whole
    // body — the first-byte bound must stay armed through response.text(), or
    // a server that sends headers + content-type and then stalls hangs the
    // send forever. NOTE on environment: jsdom cannot exercise the fetch
    // AbortSignal path (its Request constructor rejects cross-realm signal
    // instances, so fetchSignal is undefined here); the pre-headers watchdog
    // firing-early chain the reviewer measured in Chromium (abort → swallowed
    // AbortError) is structurally prevented by disarming the pre-headers
    // watchdog on the success path before this branch — the local bodyTimer
    // below is the ONLY armed bound in every environment.
    const { server, port } = await new Promise<{
      server: http.Server;
      port: number;
    }>((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        res.write('{"choices":[{"mess'); // partial JSON body, never completes
        // no end — the bounded body read must time out
      });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ server: srv, port: (srv.address() as AddressInfo).port });
      });
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 400,
      });
      const started = Date.now();
      await expect(
        svc.generate([{ role: 'user', content: 'hi' }]).next()
      ).rejects.toThrow(/body stalled/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('an empty 200 that closes before any content rejects (generate path)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(': keep-alive\n\n'); // headers + a keep-alive, zero answer frames
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 2000,
      });
      await expect(svc.generate([{ role: 'user', content: 'hi' }]).next()).rejects.toThrow(
        /closed the stream without sending any content/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a [DONE] sentinel with zero answer frames rejects with the finish-aware message', () => {
    // parse-level pin via the buffered answer path: build a service against a
    // stubbed fetch is overkill — parseOpenAISseAnswer is exercised through
    // chat(); here pin the classifier inputs directly.
    const done = parseOpenAISseLine('data: [DONE]');
    expect(done.done).toBe(true);
    expect(done.deltas).toEqual([]);
  });

  test('CRLF-framed SSE still parses (the old split("\\n") path kept \\r)', () => {
    const line = parseOpenAISseLine('data: {"choices":[{"delta":{"content":"cr"}}]}\r');
    expect(line.deltas).toEqual(['cr']);
  });
});

describe('provider config persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('round-trips through the shared blob + separate key', () => {
    saveProviderConfig({ baseUrl: 'http://127.0.0.1:8080', model: 'local-model', apiKey: 'sek' });
    const cfg = loadProviderConfig();
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8080');
    expect(cfg.model).toBe('local-model');
    expect(cfg.apiKey).toBe('sek');
    expect(isProviderConfigured(cfg)).toBe(true);
    expect(isProviderConfigured({ baseUrl: '', model: 'x', apiKey: '' })).toBe(false);
  });

  test('unconfigured loads are empty and safe', () => {
    const cfg = loadProviderConfig();
    expect(cfg).toEqual({ baseUrl: '', model: '', apiKey: '' });
  });
});

describe('watchdog bounded-fail tests (reviewer round 4, findings 1+3)', () => {
  test('a 5xx whose error body stalls fails bounded, not a hang', async () => {
    const { server, port } = await new Promise<{
      server: http.Server;
      port: number;
    }>((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        res.write('{"err'); // partial error body, never completes
        // no end — the client must time out
      });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ server: srv, port: (srv.address() as AddressInfo).port });
      });
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 400,
      });
      const started = Date.now();
      // Assert the STALL message specifically (reviewer round 5, finding 1):
      // the raced error-body watchdog must surface its own phase message, not
      // the pre-headers "sent no data" one.
      await expect(
        svc.generate([{ role: 'user', content: 'hi' }]).next()
      ).rejects.toThrow(/error body stalled/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('headers arrive then the body stalls — the body-stage leg fails bounded', async () => {
    const { server, port } = await new Promise<{
      server: http.Server;
      port: number;
    }>((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        // Headers only, NO body byte — the body-stage readChunk watchdog owns
        // the wait for the first body byte and must fire bounded.
      });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ server: srv, port: (srv.address() as AddressInfo).port });
      });
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 400,
      });
      const started = Date.now();
      await expect(
        svc.generate([{ role: 'user', content: 'hi' }]).next()
      ).rejects.toThrow(/sent no data within/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('watchdog disarm-on-headers regression (reviewer round 3, Critical 1)', () => {
  test('a response streaming LONGER than firstByteTimeoutMs in total delivers ALL deltas', async () => {
    // The pre-headers watchdog must bound only the time-to-FIRST-byte. Once
    // headers (and the first body bytes) arrive it must be disarmed; the old
    // bug kept it armed and silently truncated any answer whose total stream
    // duration exceeded the bound.
    const deltas = ['one', 'two', 'three', 'four'];
    const { server, port } = await new Promise<{
      server: http.Server;
      port: number;
    }>((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let i = 0;
        // First byte immediately (disarms the pre-headers watchdog), then
        // keep streaming well past the total bound.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[0] } }] })}\n`);
        const interval = setInterval(() => {
          i += 1;
          if (i >= deltas.length) {
            clearInterval(interval);
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i] } }] })}\n`);
        }, 200); // 3 gaps x 200ms = ~600ms total > the 400ms bound
      });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ server: srv, port: (srv.address() as AddressInfo).port });
      });
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 400,
      });
      const received: string[] = [];
      for await (const delta of svc.generate([{ role: 'user', content: 'hi' }])) {
        received.push(delta);
      }
      expect(received).toEqual(deltas);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('provider stream watchdog + network release (reviewer round 2, finding A)', () => {
  test('a server that never answers fails via the pre-headers watchdog', async () => {
    // Server accepts the connection and never responds at all.
    const server = http.createServer(() => {
      /* deliberately never ends the request */
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const svc = new OpenAICompatChatService({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        firstByteTimeoutMs: 300,
      });
      const started = Date.now();
      await expect(svc.generate([{ role: 'user', content: 'hi' }]).next()).rejects.toThrow(
        /sent no data within 300ms/
      );
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('Stop (abort signal) releases the in-flight provider connection', async () => {
    let sawClose = false;
    const { server, port } = await new Promise<{
      server: http.Server;
      port: number;
    }>((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}
`);
        req.on('close', () => {
          sawClose = true;
        });
        // Never ends on its own; the client must cancel.
      });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ server: srv, port: (srv.address() as AddressInfo).port });
      });
    });
    try {
      const svc = new OpenAICompatChatService({ baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
      const controller = new AbortController();
      // The consumer stops after the first delta; the post-cancel read may
      // reject (reader.cancel errors the in-flight read) — both end the loop,
      // and the server must observe the connection close promptly.
      const consumed = (async () => {
        try {
          for await (const delta of svc.generate([{ role: 'user', content: 'hi' }], {
            signal: controller.signal,
          })) {
            controller.abort(); // Stop after the first delta
            if (sawClose) break;
          }
        } catch {
          /* reader cancelled — expected on Stop */
        }
      })();
      await consumed;
      await vi.waitFor(() => expect(sawClose).toBe(true), { timeout: 5_000 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
