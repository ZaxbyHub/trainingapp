/**
 * universal-provider-settings-overhaul (AC2/AC3/AC10/AC11/AC14): browser
 * external-generator transport and factory behavior.
 *   - every request refuses redirects: a 3xx fails the call and the redirect
 *     target receives nothing (the key is never replayed to it);
 *   - upstream error text is scrubbed of the key;
 *   - a stream that goes silent mid-body fails with an idle timeout;
 *   - Anthropic turns are normalized (system top-level, same-role merged,
 *     first/last turn user);
 *   - the factory never builds a generator (and never fetches) for a disabled
 *     or refused config.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AnthropicCompatChatService, toAnthropicMessages } from './anthropic-provider';
import { OpenAICompatChatService } from './openai-provider';
import {
  DEFAULT_EXTERNAL_CONFIG,
  ProviderError,
  createExternalLLMService,
  probeExternalEndpoint,
  scrubSecrets,
} from './external-provider';

const KEY = 'sk-browser-SENTINEL-1357';
const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function server(handler: http.RequestListener): Promise<{ base: string; hits: Array<{ url: string; headers: http.IncomingHttpHeaders }> }> {
  const hits: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const s = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a failure');
}

describe('redirect refusal (both protocols, generation and listing)', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    test(`${protocol}: a 3xx fails and the redirect target never sees the key`, async () => {
      const target = await server((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
      const first = await server((_req, res) => {
        res.writeHead(302, { location: `${target.base}/steal` });
        res.end();
      });
      const svc =
        protocol === 'openai'
          ? new OpenAICompatChatService({ baseUrl: first.base, model: 'm', apiKey: KEY })
          : new AnthropicCompatChatService({ baseUrl: first.base, model: 'm', apiKey: KEY });
      const err = await failure(svc.generateComplete([{ role: 'user', content: 'hi' }]));
      expect(err.kind).toBe('network');
      expect(err.message).toMatch(/redirect/i);
      expect(first.hits).toHaveLength(1);
      expect(target.hits).toHaveLength(0);
      expect(err.message).not.toContain(KEY);
      const probe = await probeExternalEndpoint({ protocol, baseUrl: first.base, model: 'm', apiKey: KEY });
      expect(probe.ok).toBe(false);
      expect(target.hits).toHaveLength(0);
    });
  }
});

test('an upstream error body that echoes the key is scrubbed', async () => {
  const echo = await server((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad key ${String(req.headers.authorization)}` } }));
  });
  const err = await failure(new OpenAICompatChatService({ baseUrl: echo.base, model: 'm', apiKey: KEY }).generateComplete([{ role: 'user', content: 'x' }]));
  expect(err.kind).toBe('auth');
  expect(err.message).not.toContain(KEY);
  expect(scrubSecrets(`token sk-otherkey1234 and ${KEY}`, KEY)).not.toMatch(/otherkey1234|SENTINEL/);
});

test('a stream that goes silent mid-body fails with an idle timeout', async () => {
  const stall = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
  });
  const svc = new OpenAICompatChatService({ baseUrl: stall.base, model: 'm', firstByteTimeoutMs: 5_000, idleTimeoutMs: 200 });
  const err = await failure(svc.generateComplete([{ role: 'user', content: 'x' }]));
  expect(err.kind).toBe('timeout');
  expect(err.message).toMatch(/silent/);
});

describe('Anthropic message normalization', () => {
  test('system is top-level; consecutive same-role turns merge; first and last turns are user', () => {
    const shaped = toAnthropicMessages([
      { role: 'system', content: 'S1' },
      { role: 'assistant', content: 'stray leading assistant' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'trailing assistant' },
    ]);
    expect(shaped.system).toBe('S1\n\nS2');
    expect(shaped.messages).toEqual([
      { role: 'user', content: 'u1\n\nu2' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u3' },
    ]);
  });

  test('a conversation with no user turn is refused before any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new AnthropicCompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
    await expect(svc.generateComplete([{ role: 'assistant', content: 'only me' }])).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('factory egress gate', () => {
  test('disabled, model-less, metadata, userinfo and public-http configs build nothing and fetch nothing', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const base = { ...DEFAULT_EXTERNAL_CONFIG, enabled: true, model: 'm' };
    expect(createExternalLLMService({ ...base, enabled: false, baseUrl: 'http://127.0.0.1:1' })).toBeNull();
    expect(createExternalLLMService({ ...base, model: '', baseUrl: 'http://127.0.0.1:1' })).toBeNull();
    expect(createExternalLLMService({ ...base, baseUrl: 'http://[::ffff:a9fe:a9fe]' })).toBeNull();
    expect(createExternalLLMService({ ...base, baseUrl: 'http://u:p@127.0.0.1:1' })).toBeNull();
    expect(createExternalLLMService({ ...base, baseUrl: 'http://api.openai.com' })).toBeNull();
    expect(createExternalLLMService({ ...base, baseUrl: 'http://192.168.1.5:8000' })).not.toBeNull();
    expect(createExternalLLMService({ ...base, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' })?.getInferenceMode()).toBe(
      'anthropic-compat',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the probe refuses a policy-violating URL without any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await probeExternalEndpoint({ protocol: 'openai', baseUrl: 'http://169.254.169.254', model: 'm' });
    expect(r).toMatchObject({ ok: false, kind: 'other' });
    expect(r.message).toMatch(/metadata/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Review round 1 (F4): a key with a character that cannot travel in an HTTP
// header is refused before any request, as a classified, key-free error, on
// generation and on the connection test, for both protocols.
describe('unsendable API key (header-invalid characters)', () => {
  const BAD_KEYS = ['sk-UNSENDABLE-\u2603-SENTINEL', 'sk-UNSENDABLE-SENTINEL\r\nX-Evil: 1', 'sk-UNSENDABLE-\u0000-SENTINEL'];
  for (const protocol of ['openai', 'anthropic'] as const) {
    for (const bad of BAD_KEYS) {
      test(`${protocol}: ${JSON.stringify(bad.slice(14, 16))} fails as auth, sends nothing, never echoes the key`, async () => {
        const target = await server((_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
        const svc =
          protocol === 'openai'
            ? new OpenAICompatChatService({ baseUrl: target.base, model: 'm', apiKey: bad })
            : new AnthropicCompatChatService({ baseUrl: target.base, model: 'm', apiKey: bad });
        const err = await failure(svc.generateComplete([{ role: 'user', content: 'hi' }]));
        expect(err.kind).toBe('auth');
        expect(err.message).toMatch(/cannot be sent in an HTTP header/);
        expect(err.message).not.toContain('SENTINEL');
        const probe = await probeExternalEndpoint({ protocol, baseUrl: target.base, model: 'm', apiKey: bad });
        expect(probe).toMatchObject({ ok: false, kind: 'auth' });
        expect(probe.message).not.toContain('SENTINEL');
        expect(target.hits).toHaveLength(0);
      });
    }
  }

  test('a residual header TypeError from fetch maps to the same key-free error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Headers.append: "Bearer sk-RESIDUAL-SENTINEL" is an invalid header value.');
      }),
    );
    const svc = new OpenAICompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'sk-RESIDUAL-SENTINEL' });
    const err = await failure(svc.generateComplete([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('SENTINEL');
  });
});
