/**
 * universal-provider-settings-overhaul, review round 1 (F2): browser
 * key-origin binding, parity with the desktop backend (ADR-0011 decision 3).
 *   - a saved key is sent ONLY to the origin it was entered for: after the
 *     base URL moves to another origin, generation (both protocols) and the
 *     connection test send NO Authorization / x-api-key; pointing back uses it;
 *   - origin normalization twins the desktop (WHATWG origin): case, default
 *     ports and paths do not matter; scheme, host and port do;
 *   - re-entering the key is what rebinds it; clearing / resetting the base
 *     URL never rebinds; a key entered before any URL binds to the first one;
 *   - migration: a key saved by an earlier build (no origin entry) binds to
 *     the stored base URL's origin, or is dropped when there is none;
 *   - the key never appears in error text.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createExternalLLMService,
  keyForBaseUrl,
  keyOriginOf,
  loadExternalConfig,
  loadExternalKeyState,
  probeExternalEndpoint,
  saveExternalConfig,
} from './external-provider';
import { migrateLegacyProviderBlob } from './external-migration';

const KEY = 'sk-binding-SENTINEL-8642';
const KEY2 = 'sk-binding-SECOND-9753';

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** An endpoint speaking enough of both protocols; records every request. */
async function endpoint(): Promise<{ base: string; origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const url = req.url ?? '';
      if (url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.endsWith('/messages')) {
        res.end(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        );
        return;
      }
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { base, origin: base, hits };
}

const keyHeaders = (h: Hit): Array<string | undefined> => [h.headers.authorization, h.headers['x-api-key'] as string | undefined];
const sentNoKey = (hits: Hit[]): void => {
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) {
    expect(keyHeaders(h)).toEqual([undefined, undefined]);
    expect(h.body).not.toContain(KEY);
    expect(h.url).not.toContain(KEY);
  }
};

async function generate(): Promise<string> {
  const svc = createExternalLLMService(loadExternalConfig());
  expect(svc).not.toBeNull();
  try {
    return await (svc as NonNullable<typeof svc>).generateComplete([{ role: 'user', content: 'hi' }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain(KEY);
    return '';
  }
}

describe('A -> B: the saved key is never sent to another origin', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    test(`${protocol}: generation and the connection test send no key to B; pointing back at A sends it again`, async () => {
      const a = await endpoint();
      const b = await endpoint();
      saveExternalConfig({ enabled: true, protocol, baseUrl: a.base, model: 'm', apiKey: KEY, rememberKey: true });
      await generate();
      const expectHeader = protocol === 'openai' ? [`Bearer ${KEY}`, undefined] : [undefined, KEY];
      expect(keyHeaders(a.hits[0] as Hit)).toEqual(expectHeader);

      saveExternalConfig({ baseUrl: b.base });
      expect(loadExternalConfig().apiKey).toBe('');
      expect(keyForBaseUrl(b.base)).toBe('');
      expect(loadExternalKeyState()).toEqual({ status: 'mismatch', boundOrigin: a.origin, currentOrigin: b.origin });
      await generate();
      const probe = await probeExternalEndpoint({ protocol, baseUrl: b.base, model: 'm', apiKey: keyForBaseUrl(b.base) });
      expect(probe.message).not.toContain(KEY);
      sentNoKey(b.hits);
      expect(b.hits.some((h) => h.url.includes('/models'))).toBe(true);
      expect(b.hits.some((h) => h.method === 'POST')).toBe(true);

      // The key was kept (not deleted, not rebound): pointing back uses it.
      expect(localStorage.getItem('external-provider-apikey')).toBe(KEY);
      saveExternalConfig({ baseUrl: `${a.base}/v1/` });
      expect(loadExternalKeyState()).toEqual({ status: 'bound', origin: a.origin });
      const before = a.hits.length;
      await generate();
      expect(keyHeaders(a.hits[before] as Hit)).toEqual(expectHeader);
    });
  }

  test('a session-only key is bound the same way', async () => {
    const a = await endpoint();
    const b = await endpoint();
    saveExternalConfig({ enabled: true, baseUrl: a.base, model: 'm', apiKey: KEY, rememberKey: false });
    expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe(a.origin);
    saveExternalConfig({ baseUrl: b.base });
    await generate();
    sentNoKey(b.hits);
  });
});

describe('origin normalization (twin of the desktop originOf)', () => {
  const ROWS: Array<[string, string, boolean]> = [
    ['https://api.example.com', 'https://api.example.com:443', true],
    ['https://api.example.com:443/v1', 'https://api.example.com', true],
    ['https://API.Example.COM/v1/', 'https://api.example.com/v1/chat/completions', true],
    ['http://LOCALHOST:1234', 'http://localhost:1234/v1', true],
    ['http://localhost', 'http://localhost:80', true],
    ['  http://gpu-box.lan:8000/  ', 'http://gpu-box.lan:8000', true],
    ['http://localhost:1234', 'http://127.0.0.1:1234', false],
    ['http://localhost:1234', 'http://localhost:1235', false],
    ['http://gpu-box.lan:8000', 'https://gpu-box.lan:8000', false],
    ['https://api.example.com', 'https://api.example.com:8443', false],
    ['https://api.example.com', 'https://evil.example.com', false],
    ['https://api.example.com', 'https://api.example.com.evil.test', false],
  ];
  for (const [bound, other, same] of ROWS) {
    test(`${bound} vs ${other}: ${same ? 'same origin, key sent' : 'different origin, no key'}`, () => {
      saveExternalConfig({ baseUrl: bound, apiKey: KEY });
      expect(keyForBaseUrl(other)).toBe(same ? KEY : '');
      expect(keyOriginOf(bound) === keyOriginOf(other)).toBe(same);
    });
  }

  test('non-http(s) or unparsable input has no origin', () => {
    expect(keyOriginOf('')).toBe('');
    expect(keyOriginOf('not a url')).toBe('');
    expect(keyOriginOf('ftp://example.com')).toBe('');
    expect(keyOriginOf('file:///etc/passwd')).toBe('');
  });
});

describe('binding lifecycle', () => {
  test('re-entering the key binds it to the new origin (and away from the old one)', () => {
    saveExternalConfig({ baseUrl: 'http://localhost:1234', apiKey: KEY });
    saveExternalConfig({ baseUrl: 'http://192.168.1.20:8000' });
    expect(loadExternalKeyState().status).toBe('mismatch');
    saveExternalConfig({ apiKey: KEY2 });
    expect(loadExternalKeyState()).toEqual({ status: 'bound', origin: 'http://192.168.1.20:8000' });
    expect(keyForBaseUrl('http://192.168.1.20:8000')).toBe(KEY2);
    expect(keyForBaseUrl('http://localhost:1234')).toBe('');
  });

  test('an explicit keyOrigin binds to the URL the user sees, not the stored one', () => {
    saveExternalConfig({ baseUrl: 'http://localhost:1234' });
    saveExternalConfig({ apiKey: KEY }, { keyOrigin: 'http://192.168.1.20:8000/v1' });
    expect(keyForBaseUrl('http://localhost:1234')).toBe('');
    expect(keyForBaseUrl('http://192.168.1.20:8000')).toBe(KEY);
  });

  test('clearing or resetting the base URL never rebinds the key', () => {
    saveExternalConfig({ baseUrl: 'http://localhost:1234', apiKey: KEY });
    saveExternalConfig({ baseUrl: '' });
    expect(loadExternalKeyState()).toEqual({ status: 'mismatch', boundOrigin: 'http://localhost:1234', currentOrigin: '' });
    saveExternalConfig({ baseUrl: 'https://evil.example.com' });
    expect(keyForBaseUrl('https://evil.example.com')).toBe('');
    expect(loadExternalConfig().apiKey).toBe('');
    saveExternalConfig({ baseUrl: 'http://localhost:1234' });
    expect(loadExternalConfig().apiKey).toBe(KEY);
  });

  test('a key entered before any base URL is pending (sent nowhere) and binds to the first origin set', () => {
    saveExternalConfig({ apiKey: KEY });
    expect(loadExternalKeyState()).toEqual({ status: 'pending' });
    expect(keyForBaseUrl('http://localhost:1234')).toBe('');
    saveExternalConfig({ baseUrl: 'http://localhost:1234' });
    expect(loadExternalKeyState()).toEqual({ status: 'bound', origin: 'http://localhost:1234' });
    saveExternalConfig({ baseUrl: 'http://localhost:9999' });
    expect(keyForBaseUrl('http://localhost:9999')).toBe('');
  });

  test('Remember moves the key AND its binding between storages; clearing removes both', () => {
    saveExternalConfig({ baseUrl: 'http://localhost:1234', apiKey: KEY, rememberKey: false });
    expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe('http://localhost:1234');
    saveExternalConfig({ rememberKey: true });
    expect(localStorage.getItem('external-provider-apikey')).toBe(KEY);
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe('http://localhost:1234');
    expect(sessionStorage.getItem('external-provider-apikey')).toBeNull();
    expect(sessionStorage.getItem('external-provider-apikey-origin')).toBeNull();
    saveExternalConfig({ apiKey: '' });
    for (const s of [localStorage, sessionStorage]) {
      expect(s.getItem('external-provider-apikey')).toBeNull();
      expect(s.getItem('external-provider-apikey-origin')).toBeNull();
    }
  });
});

describe('migration of a key saved without a bound origin', () => {
  const config = (extra: Record<string, unknown>) =>
    localStorage.setItem('external-provider-config', JSON.stringify({ enabled: true, protocol: 'openai', model: 'm', ...extra }));

  test('remembered key + stored base URL: bound to that origin (written back), never sent elsewhere', () => {
    config({ baseUrl: 'http://localhost:1234/v1', rememberKey: true });
    localStorage.setItem('external-provider-apikey', KEY);
    expect(loadExternalConfig().apiKey).toBe(KEY);
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe('http://localhost:1234');
    expect(keyForBaseUrl('http://127.0.0.1:1234')).toBe('');
  });

  test('session key + stored base URL: bound in sessionStorage', () => {
    config({ baseUrl: 'http://192.168.1.20:8000', rememberKey: false });
    sessionStorage.setItem('external-provider-apikey', KEY);
    expect(loadExternalKeyState()).toEqual({ status: 'bound', origin: 'http://192.168.1.20:8000' });
    expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe('http://192.168.1.20:8000');
  });

  test('key without any stored base URL: dropped (it cannot be attributed to an endpoint)', () => {
    config({ baseUrl: '', rememberKey: true });
    localStorage.setItem('external-provider-apikey', KEY);
    expect(loadExternalConfig().apiKey).toBe('');
    expect(loadExternalKeyState()).toEqual({ status: 'none' });
    expect(localStorage.getItem('external-provider-apikey')).toBeNull();
  });

  test('key with an unparsable stored base URL: dropped', () => {
    config({ baseUrl: 'not a url', rememberKey: true });
    localStorage.setItem('external-provider-apikey', KEY);
    expect(keyForBaseUrl('http://localhost:1234')).toBe('');
    expect(localStorage.getItem('external-provider-apikey')).toBeNull();
  });

  test('a later base URL change after migration does not carry the key along', () => {
    config({ baseUrl: 'http://localhost:1234', rememberKey: true });
    localStorage.setItem('external-provider-apikey', KEY);
    saveExternalConfig({ baseUrl: 'https://evil.example.com' });
    expect(keyForBaseUrl('https://evil.example.com')).toBe('');
    expect(loadExternalKeyState()).toMatchObject({ status: 'mismatch', boundOrigin: 'http://localhost:1234' });
  });

  test('the PR #138 legacy migration binds the moved key to the legacy base URL origin', () => {
    localStorage.setItem('openai-provider-apikey', KEY);
    migrateLegacyProviderBlob({ mode: 'provider', providerConfig: { baseUrl: 'http://localhost:1234/v1', model: 'm' } });
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe('http://localhost:1234');
    expect(keyForBaseUrl('http://localhost:1234')).toBe(KEY);
    expect(keyForBaseUrl('http://localhost:4321')).toBe('');
  });
});
