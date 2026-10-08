// universal-provider-settings-overhaul: desktop engine/host behavior of the
// external model endpoint (AC5-AC8, AC10, AC13, AC14).
//   - key-origin binding (constraints I1/I2): separate secret entries; key
//     saved with/without/after a base URL; repoint sends no key; pointing back
//     re-enables; restart keeps it; reset deletes both entries;
//   - POST /settings/external/test: kinds, draft key, bound-origin key
//     selection, nothing persisted;
//   - Direct chat (external.grounded=false) skips retrieval;
//   - tolerant boot replay of external.json; settings.json never carries
//     external.* (downgrade-safe);
//   - the local llama.cpp prompt is byte-identical (PRESERVING);
//   - status/stats never leak the key; cancellation releases the queue.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBackendHost } from '../../main/backend';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { createMemorySecretStore } from '../../main/security/secret-store';
import { ExternalProviderError } from '../../main/backend/net/provider-error';
import type { RetrievalSurface } from '../../main/backend/types';

const TOKEN = 'ext-engine-token';
const KEY = 'sk-engine-SENTINEL-5150';

interface Recorded {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const servers: http.Server[] = [];
const dirs: string[] = [];
const hosts: NodeBackendHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.stop();
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  delete process.env.TRAININGAPP_AIRGAP;
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function mapStore() {
  const data = new Map<string, string>();
  return {
    get: (n: string) => data.get(n) ?? null,
    set: (n: string, v: string) => {
      data.set(n, v);
    },
    delete: (n: string) => {
      data.delete(n);
    },
    dump: () => Object.fromEntries(data),
  };
}

/** An OpenAI-shaped endpoint: streams one answer; /v1/models lists `models`. */
async function endpoint(opts: { models?: string[]; status?: number; hang?: boolean } = {}): Promise<{ base: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      if (opts.hang) return;
      if (opts.status !== undefined) {
        res.writeHead(opts.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'nope' } }));
        return;
      }
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: (opts.models ?? ['m1']).map((id) => ({ id })) }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'EXT-OK' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, requests };
}

function newEngine(store = mapStore(), extra: Record<string, unknown> = {}) {
  const llamaFactory = vi.fn(async () => {
    throw new Error('local model must not load');
  });
  const engine = new LlamaEngine({
    modelDir: tmp('ext-models-'),
    llamaFactory,
    externalProvider: { secretStore: store, ...extra },
  });
  return { engine, store, llamaFactory };
}

const enable = (base: string, extra: Record<string, unknown> = {}) => ({
  'external.enabled': true,
  'external.protocol': 'openai',
  'external.baseUrl': base,
  'external.model': 'm1',
  ...extra,
});

describe('key-origin binding (I1/I2)', () => {
  it('stores the key and its bound origin as SEPARATE secret entries; reset deletes both', () => {
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch(enable('http://127.0.0.1:9', { 'external.apiKey': KEY })).ok).toBe(true);
    expect(store.dump()).toEqual({ 'external-api-key': KEY, 'external-api-key-origin': 'http://127.0.0.1:9' });
    expect(engine.resetSettings(['external.apiKey']).ok).toBe(true);
    expect(store.dump()).toEqual({});
    expect(engine.responseSettings()['external.apiKeySet']).toBe(false);
  });

  it('a key saved alone while a URL is configured binds to the current origin (I2) and is sent', async () => {
    const ext = await endpoint();
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch(enable(ext.base)).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'external.apiKey': KEY }).ok).toBe(true);
    expect(store.dump()['external-api-key-origin']).toBe(ext.base);
    await engine.query('hello');
    expect(ext.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  // Review round 2 (R2-F1): the Settings panel sends a typed key TOGETHER with
  // the base URL shown, in one PUT. The previously configured endpoint C never
  // receives that key; the key is bound to the URL it was typed for.
  it('a key PUT together with a new base URL binds to that URL; the previously configured endpoint never receives it', async () => {
    const c = await endpoint();
    const d = await endpoint();
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch(enable(c.base)).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'external.baseUrl': d.base, 'external.apiKey': KEY }).ok).toBe(true);
    expect(store.dump()['external-api-key-origin']).toBe(d.base);
    await engine.query('to d');
    expect(d.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(engine.applySettingsPatch({ 'external.baseUrl': c.base }).ok).toBe(true);
    await engine.query('to c');
    expect(c.requests).toHaveLength(1);
    expect(c.requests[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(c.requests)).not.toContain(KEY);
    expect(engine.responseSettings()['external.apiKeyBoundOrigin']).toBe(d.base);
  });

  it('a key PUT with a refused base URL commits nothing (the key is not bound to the configured URL)', async () => {
    const c = await endpoint();
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch(enable(c.base)).ok).toBe(true);
    const r = engine.applySettingsPatch({ 'external.baseUrl': 'http://api.openai.com/v1', 'external.apiKey': KEY });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(store.dump()).toEqual({});
    await engine.query('to c');
    expect(c.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('a key saved before any URL binds to the first origin set afterwards', async () => {
    const ext = await endpoint();
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch({ 'external.apiKey': KEY }).ok).toBe(true);
    expect(store.dump()['external-api-key-origin']).toBeUndefined();
    expect(engine.applySettingsPatch(enable(ext.base)).ok).toBe(true);
    expect(store.dump()['external-api-key-origin']).toBe(ext.base);
    await engine.query('hello');
    expect(ext.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('repointing to another origin sends NO key; pointing back re-enables it; the key is never deleted', async () => {
    const home = await endpoint();
    const other = await endpoint();
    const { engine, store } = newEngine();
    expect(engine.applySettingsPatch(enable(home.base, { 'external.apiKey': KEY })).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'external.baseUrl': other.base }).ok).toBe(true);
    const settings = engine.responseSettings();
    expect(settings['external.apiKeySet']).toBe(false);
    expect(settings['external.apiKeyBoundOrigin']).toBe(home.base);
    await engine.query('hello');
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(other.requests)).not.toContain(KEY);
    expect(store.dump()['external-api-key']).toBe(KEY);
    expect(engine.applySettingsPatch({ 'external.baseUrl': home.base }).ok).toBe(true);
    await engine.query('hello again');
    expect(home.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a restart (new engine, same store) keeps the key and its binding', async () => {
    const ext = await endpoint();
    const first = newEngine();
    first.engine.applySettingsPatch(enable(ext.base, { 'external.apiKey': KEY }));
    const second = newEngine(first.store);
    // Boot replay of the non-secret settings only (external.json shape).
    expect(second.engine.applySettingsPatch(enable(ext.base, { 'external.grounded': true })).ok).toBe(true);
    expect(second.engine.responseSettings()['external.apiKeySet']).toBe(true);
    await second.engine.query('hello');
    expect(ext.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  // Review L-a: the headless dev-server keeps keys in a memory store, which does not
  // survive a restart, so it must not report the key as persisted.
  it('a memory secret store reports apiKeyPersisted false; a persistent store reports true', async () => {
    const ext = await endpoint();
    const memory = newEngine(createMemorySecretStore() as unknown as ReturnType<typeof mapStore>);
    expect(memory.engine.applySettingsPatch(enable(ext.base, { 'external.apiKey': KEY })).ok).toBe(true);
    expect(memory.engine.responseSettings()['external.apiKeySet']).toBe(true);
    expect(memory.engine.responseSettings()['external.apiKeyPersisted']).toBe(false);
    const disk = newEngine();
    expect(disk.engine.applySettingsPatch(enable(ext.base, { 'external.apiKey': KEY })).ok).toBe(true);
    expect(disk.engine.responseSettings()['external.apiKeyPersisted']).toBe(true);
  });

  it('secure storage unavailable: the key is kept for the session only, never written', async () => {
    const ext = await endpoint();
    const failing = {
      get: () => null,
      set: () => {
        throw new Error('no encryption');
      },
      delete: () => undefined,
    };
    const { engine } = newEngine(failing as unknown as ReturnType<typeof mapStore>);
    expect(engine.applySettingsPatch(enable(ext.base, { 'external.apiKey': KEY })).ok).toBe(true);
    const settings = engine.responseSettings();
    expect(settings['external.apiKeyPersisted']).toBe(false);
    expect(settings['external.apiKeySet']).toBe(true);
    await engine.query('hello');
    expect(ext.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a key with control characters (header injection) is refused and nothing commits', () => {
    const { engine, store } = newEngine();
    const r = engine.applySettingsPatch(enable('http://127.0.0.1:9', { 'external.apiKey': 'sk-x\r\nX-Evil: 1' }));
    expect(r.ok).toBe(false);
    expect(store.dump()).toEqual({});
    expect(engine.responseSettings()['external.enabled']).toBe(false);
  });

  // Review round 1 (F4): any character that cannot travel in an HTTP header
  // (CR/LF, TAB, NUL, DEL, anything above Latin-1) is refused at save time
  // with a typed validation error that never echoes the key.
  for (const [label, bad] of [
    ['non-Latin-1 (snowman)', 'sk-UNSENDABLE-☃-SENTINEL'],
    ['non-Latin-1 (emoji)', 'sk-UNSENDABLE-\u{1F511}-SENTINEL'],
    ['CR/LF', 'sk-UNSENDABLE-SENTINEL\r\nX-Evil: 1'],
    ['TAB', 'sk-UNSENDABLE-\t-SENTINEL'],
    ['NUL', 'sk-UNSENDABLE-\u0000-SENTINEL'],
    ['DEL', 'sk-UNSENDABLE-\u007f-SENTINEL'],
  ] as const) {
    it(`a key with an unsendable character (${label}) is refused with a 422 that never echoes it`, () => {
      const { engine, store } = newEngine();
      const r = engine.applySettingsPatch(enable('http://127.0.0.1:9', { 'external.apiKey': bad }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(422);
      const text = JSON.stringify(r);
      expect(text).toMatch(/external\.apiKey: the API key contains a character that cannot be sent in an HTTP header/);
      expect(text).not.toContain('SENTINEL');
      expect(store.dump()).toEqual({});
    });
  }

  it('Latin-1 punctuation in a key is still accepted (only header-invalid characters are refused)', () => {
    const { engine, store } = newEngine();
    const r = engine.applySettingsPatch(enable('http://127.0.0.1:9', { 'external.apiKey': 'sk-ok_key.with-punct~=+/é' }));
    expect(r.ok).toBe(true);
    expect(store.dump()['external-api-key']).toBe('sk-ok_key.with-punct~=+/é');
  });

  it('a pre-existing stored key that cannot be sent fails generation as a classified error, key-free', async () => {
    const ext = await endpoint();
    const store = mapStore();
    // Seeded directly (as an older build could have saved it), bypassing validation.
    store.set('external-api-key', 'sk-STORED-☃-SENTINEL');
    store.set('external-api-key-origin', ext.base);
    const { engine } = newEngine(store);
    expect(engine.applySettingsPatch(enable(ext.base)).ok).toBe(true);
    const err = await engine.query('q').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExternalProviderError);
    expect((err as ExternalProviderError).kind).toBe('auth');
    expect((err as ExternalProviderError).message).not.toContain('SENTINEL');
    expect(ext.requests).toHaveLength(0);
  });

  it('the probe route refuses an unsendable draft key without echoing it', async () => {
    const { engine } = newEngine();
    const r = await engine.probeExternal({ protocol: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'sk-☃-SENTINEL' });
    expect(r).toMatchObject({ ok: false, kind: 'other' });
    expect(r.message).toMatch(/cannot be sent in an HTTP header/);
    expect(r.message).not.toContain('SENTINEL');
  });
});

describe('F4: /ask and /ask/stream map an unsendable stored key to 502 {detail, kind} / a kind frame', () => {
  it('both routes classify the failure and never leak the key', async () => {
    const ext = await endpoint();
    const store = mapStore();
    store.set('external-api-key', 'sk-ROUTE-☃-SENTINEL');
    store.set('external-api-key-origin', ext.base);
    const { engine } = newEngine(store);
    // Direct chat: no retrieval surface needed for the route.
    expect(engine.applySettingsPatch(enable(ext.base, { 'external.grounded': false })).ok).toBe(true);
    const server = createBackendServer({ guard: createLoopbackGuard({ token: TOKEN }), tokenHeaderName: 'X-Desktop-Token', engine });
    const port = await listenOnRandomPort(server);
    servers.push(server);
    const headers = { 'content-type': 'application/json', 'x-desktop-token': TOKEN };
    const ask = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'q' }) });
    expect(ask.status).toBe(502);
    const body = (await ask.json()) as Record<string, unknown>;
    expect(body.kind).toBe('auth');
    expect(String(body.detail)).toMatch(/cannot be sent in an HTTP header/);
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    const stream = await fetch(`http://127.0.0.1:${port}/ask/stream`, { method: 'POST', headers, body: JSON.stringify({ question: 'q' }) });
    const text = await stream.text();
    expect(text).toMatch(/"kind":"auth"/);
    expect(text).not.toContain('SENTINEL');
    expect(ext.requests).toHaveLength(0);
  });
});

describe('POST /settings/external/test (connection probe)', () => {
  async function backend(store = mapStore()) {
    const { engine } = newEngine(store);
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine,
    });
    const port = await listenOnRandomPort(server);
    servers.push(server);
    const probe = async (body: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}/settings/external/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { engine, store, probe };
  }

  it('classifies ok / model / auth / network / timeout and persists nothing', async () => {
    const { store, engine, probe } = await backend();
    const good = await endpoint({ models: ['a', 'm1'] });
    expect((await probe({ protocol: 'openai', baseUrl: good.base, model: 'm1' })).body).toMatchObject({ ok: true, models: ['a', 'm1'] });
    expect((await probe({ protocol: 'openai', baseUrl: good.base, model: 'zzz' })).body).toMatchObject({ ok: false, kind: 'model' });
    const denied = await endpoint({ status: 401 });
    const auth = await probe({ protocol: 'openai', baseUrl: denied.base, model: 'm1', apiKey: KEY });
    expect(auth.body).toMatchObject({ ok: false, kind: 'auth' });
    expect(JSON.stringify(auth.body)).not.toContain(KEY);
    expect((await probe({ protocol: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm1' })).body).toMatchObject({ ok: false, kind: 'network' });
    expect((await probe({ protocol: 'openai', baseUrl: 'http://169.254.169.254', model: 'm1' })).body).toMatchObject({ ok: false });
    expect(store.dump()).toEqual({});
    expect(engine.responseSettings()['external.baseUrl']).toBe('');
  });

  it('uses a draft key for the probe only; otherwise sends the stored key ONLY to its bound origin', async () => {
    const home = await endpoint();
    const other = await endpoint();
    const { engine, probe } = await backend();
    engine.applySettingsPatch(enable(home.base, { 'external.apiKey': KEY }));
    await probe({ protocol: 'openai', baseUrl: home.base, model: 'm1' });
    expect(home.requests.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
    await probe({ protocol: 'openai', baseUrl: other.base, model: 'm1' });
    expect(other.requests.at(-1)?.headers.authorization).toBeUndefined();
    await probe({ protocol: 'openai', baseUrl: other.base, model: 'm1', apiKey: 'sk-draft-only-1234' });
    expect(other.requests.at(-1)?.headers.authorization).toBe('Bearer sk-draft-only-1234');
    // the draft key never replaced the stored one
    expect(engine.responseSettings()['external.apiKeyBoundOrigin']).toBe(home.base);
  });

  it('times out a hung endpoint within the probe bound', async () => {
    const hang = await endpoint({ hang: true });
    const { engine } = newEngine();
    const started = Date.now();
    const result = await Promise.race([
      engine.probeExternal({ protocol: 'openai', baseUrl: hang.base, model: 'm1' }),
      new Promise((resolve) => setTimeout(() => resolve('test-timeout'), 20_000)),
    ]);
    const elapsed = Date.now() - started;
    expect(result).not.toBe('test-timeout');
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    // PR #142 review F-016: a lower bound too — the probe's 15 s first-byte
    // timer actually ran, so a probe that answered at once cannot pass.
    expect(elapsed).toBeGreaterThanOrEqual(14_500);
    expect(elapsed).toBeLessThan(20_000);
  }, 30_000);
});

describe('direct chat, status and cancellation', () => {
  function surface(calls: string[]): RetrievalSurface {
    return {
      search: async (query: string) => {
        calls.push(query);
        return [{ text: 'RETRIEVED-PASSAGE-ZETA', source: 'doc.txt', similarity: 0.9, chunkId: 'c1' }];
      },
      floorActive: true,
      rerankDefault: true,
    } as unknown as RetrievalSurface;
  }

  it('grounded (default) sends the retrieved passage; Direct chat skips retrieval and is "general"', async () => {
    const ext = await endpoint();
    const { engine, llamaFactory } = newEngine();
    const calls: string[] = [];
    engine.attachRetrievalSurface(surface(calls));
    engine.applySettingsPatch(enable(ext.base));
    const grounded = await engine.query('what is zeta?');
    expect(grounded.grounding).toBe('grounded');
    expect(JSON.stringify(ext.requests[0]?.body)).toContain('RETRIEVED-PASSAGE-ZETA');
    engine.applySettingsPatch({ 'external.grounded': false });
    const direct = await engine.query('what is zeta?');
    expect(direct.grounding).toBe('general');
    expect(direct.sources).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(ext.requests[1]?.body)).not.toContain('RETRIEVED-PASSAGE-ZETA');
    expect(llamaFactory).not.toHaveBeenCalled();
  });

  it('status reports engine external; stats name the endpoint but never the key', async () => {
    const ext = await endpoint();
    const { engine } = newEngine();
    engine.applySettingsPatch(enable(ext.base, { 'external.apiKey': KEY }));
    expect(engine.modelStatus().engine).toBe('external');
    const stats = await engine.getStats();
    expect(stats.llm_backend).toContain(ext.base);
    expect(JSON.stringify(stats)).not.toContain(KEY);
    expect(JSON.stringify(engine.responseSettings())).not.toContain(KEY);
    await expect(engine.preflight()).resolves.toBeUndefined();
  });

  it('cancellation mid-request returns cancelled and the next query is not blocked', async () => {
    const hang = await endpoint({ hang: true });
    const { engine } = newEngine(mapStore(), { firstByteTimeoutMs: 30_000 });
    engine.applySettingsPatch(enable(hang.base));
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 150);
    const first = await engine.query('q', { cancellationEvent: { isSet: () => cancelled } });
    expect(first.cancelled).toBe(true);
    const ok = await endpoint();
    engine.applySettingsPatch({ 'external.baseUrl': ok.base });
    const second = await engine.query('q2');
    expect(second.answer).toBe('EXT-OK');
  });

  it('an external failure is a classified, key-free ExternalProviderError (502 / error frame kind)', async () => {
    const denied = await endpoint({ status: 401 });
    const { engine } = newEngine();
    engine.applySettingsPatch(enable(denied.base, { 'external.apiKey': KEY }));
    await expect(engine.query('q')).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('PRESERVING: the local llama.cpp prompt is unchanged', () => {
  it('the local path still prepends the same flat grounded string and keeps its system prompt', async () => {
    const modelDir = tmp('ext-local-');
    fs.mkdirSync(path.join(modelDir, 'gemma-4-e2b-it'), { recursive: true });
    fs.mkdirSync(path.join(modelDir, 'lfm2.5-vl-450m'), { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'gemma-4-e2b-it', 'model.gguf'), 'x');
    fs.writeFileSync(path.join(modelDir, 'lfm2.5-vl-450m', 'model.gguf'), 'x');
    const seen: string[] = [];
    const engine = new LlamaEngine({
      modelDir,
      llamaFactory: async () => ({
        generate: async (question: string) => {
          seen.push(question);
          return { answer: 'local', cancelled: false };
        },
        dispose: async () => undefined,
      }),
      externalProvider: { secretStore: mapStore() },
    });
    engine.attachRetrievalSurface({
      search: async () => [{ text: 'PASSAGE-A', source: 'a.txt', similarity: 0.9, chunkId: 'c' }],
      floorActive: true,
    } as unknown as RetrievalSurface);
    await engine.query('Q?');
    expect(seen[0]).toBe('Answer the question using the retrieved context when relevant.\n\n[1] PASSAGE-A\n\n\nQuestion: Q?');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'backend', 'inference', 'llama-engine.ts'), 'utf8');
    // #154 AC3: the desktop-local prompt now carries the same groundedness rule
    // the external path already ships. Pin the RULE, not one literal spelling, so
    // a wording change does not require editing this grep.
    expect(source).toContain("TrainingApp's local assistant");
    expect(source).toMatch(/answer only from that context/i);
    expect(source).toMatch(/does not contain the answer/i);
  });
});

describe('host persistence: external.json sidecar, tolerant boot, downgrade-safe settings.json', () => {
  async function boot(profileDir: string, store = mapStore(), env: Record<string, string> = {}) {
    const { engine } = newEngine(store);
    const host = new NodeBackendHost({
      token: TOKEN,
      tokenHeaderName: 'X-Desktop-Token',
      storePath: path.join(profileDir, 'store.sqlite'),
      engine,
      env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', ...env },
    });
    hosts.push(host);
    const handle = await host.start();
    return { host, handle, engine };
  }
  const put = (url: string, patch: Record<string, unknown>) =>
    fetch(`${url}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
      body: JSON.stringify(patch),
    });

  it('external.* lands in external.json (never settings.json); rag keys still land in settings.json', async () => {
    const profileDir = tmp('ext-host-');
    const { handle } = await boot(profileDir);
    expect((await put(handle.url, { ...enable('http://192.168.1.50:8000'), 'external.apiKey': KEY, rag_n_results: 6 })).status).toBe(200);
    const settingsJson = fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8');
    expect(settingsJson).not.toContain('external.');
    expect(JSON.parse(settingsJson)).toEqual({ rag_n_results: 6 });
    const externalJson = JSON.parse(fs.readFileSync(path.join(profileDir, 'external.json'), 'utf8')) as Record<string, unknown>;
    expect(externalJson).toEqual({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://192.168.1.50:8000',
      'external.model': 'm1',
      'external.grounded': true,
    });
    for (const file of fs.readdirSync(profileDir)) {
      const full = path.join(profileDir, file);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes(Buffer.from(KEY))).toBe(false);
    }
  });

  it('a stored public URL refused by a now-airgapped host is dropped at boot; the host starts and the rest applies', async () => {
    const profileDir = tmp('ext-host-');
    fs.writeFileSync(
      path.join(profileDir, 'external.json'),
      JSON.stringify({ ...enable('https://api.openai.com'), 'external.grounded': false }),
    );
    process.env.TRAININGAPP_AIRGAP = '1';
    const { engine } = await boot(profileDir);
    const settings = engine.responseSettings();
    expect(settings['external.enabled']).toBe(false);
    expect(settings['external.baseUrl']).toBe('');
    expect(settings['external.grounded']).toBe(false);
    expect(settings['external.airgap']).toBe(true);
  });

  it('applyEngineSettings (first-run seam) never writes external.* or the key to settings.json', async () => {
    const profileDir = tmp('ext-host-');
    const { host } = await boot(profileDir);
    const applied = host.applyEngineSettings({ ...enable('http://192.168.1.50:8000'), 'external.apiKey': KEY, rag_n_results: 7 });
    expect(applied.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'))).toEqual({ rag_n_results: 7 });
    const externalJson = JSON.parse(fs.readFileSync(path.join(profileDir, 'external.json'), 'utf8')) as Record<string, unknown>;
    expect(externalJson['external.baseUrl']).toBe('http://192.168.1.50:8000');
    expect(externalJson).not.toHaveProperty('external.apiKey');
    for (const file of fs.readdirSync(profileDir)) {
      const full = path.join(profileDir, file);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes(Buffer.from(KEY))).toBe(false);
    }
  });

  it('a stale settings.json carrying external.* (incl. a plaintext key) is not applied and is rewritten without it', async () => {
    const profileDir = tmp('ext-host-');
    fs.writeFileSync(
      path.join(profileDir, 'settings.json'),
      JSON.stringify({ rag_n_results: 5, ...enable('http://192.168.1.50:8000'), 'external.apiKey': KEY }),
    );
    const { handle, engine } = await boot(profileDir);
    const settings = engine.responseSettings();
    expect(settings['external.enabled']).toBe(false);
    expect(settings['external.apiKeySet']).toBe(false);
    expect(settings.n_results).toBe(5);
    expect((await put(handle.url, { rag_n_results: 6 })).status).toBe(200);
    const rewritten = fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8');
    expect(JSON.parse(rewritten)).toEqual({ rag_n_results: 6 });
    expect(rewritten).not.toContain(KEY);
  });

  it('a restart replays external.json so the external engine is live before the first request', async () => {
    const profileDir = tmp('ext-host-');
    const store = mapStore();
    const first = await boot(profileDir, store);
    expect((await put(first.handle.url, enable('http://192.168.1.50:8000'))).status).toBe(200);
    await hosts.pop()?.stop();
    const second = await boot(profileDir, store);
    expect(second.engine.modelStatus().engine).toBe('external');
  });
});
