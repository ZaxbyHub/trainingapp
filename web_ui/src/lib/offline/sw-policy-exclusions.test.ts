/**
 * sw-policy-exclusions (issue #34 item 7, plan R4-6/R5-7/R5-8/R6-5): the
 * app-shell service worker's RUNTIME policy beyond the frozen C3 cases — the
 * strict allowlist closure, the navigation-fallback refresh, the unmanifested
 * assets/ arm, foreign-cache preservation and the index.html
 * never-cache-first rule. Executes public/sw.js under the same stubbed
 * self/caches/fetch vm harness shape as the frozen C3 driver (R5-7: the
 * additive policy cases live here; C3 stays byte-frozen).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const SW_PATH = path.resolve(__dirname, '../../../public/sw.js');
const ORIGIN = 'http://127.0.0.1:4174';

class FakeResponse {
  body: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  constructor(body: unknown, init?: { status?: number; statusText?: string; headers?: HeadersInit }) {
    this.body = body === undefined || body === null ? '' : String(body);
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    // PRR-114(b): real Headers, so the worker's stripVary() actually runs
    // (the dev/preview server's `Vary: Origin` is modeled by netFetch below)
    // and survives clone().
    this.headers = new Headers(init?.headers);
  }
  async text(): Promise<string> {
    return this.body;
  }
  clone(): FakeResponse {
    return new FakeResponse(this.body, {
      status: this.status,
      statusText: this.statusText,
      headers: new Headers(this.headers),
    });
  }
}

interface FetchOpts {
  mode?: string;
  destination?: string;
  method?: string;
  range?: boolean;
}

function safeHeader(response: FakeResponse, name: string): string | null {
  try {
    return response.headers.get(name);
  } catch {
    return null;
  }
}

class FakeRequest {
  url: string;
  method: string;
  mode: string;
  destination: string;
  hasRange: boolean;
  headers: { get(): null; has(name: string): boolean };
  constructor(input: string, init?: FetchOpts) {
    this.url = input;
    this.method = init?.method ?? 'GET';
    this.mode = init?.mode ?? 'navigate';
    this.destination = init?.destination ?? '';
    this.hasRange = init?.range === true;
    this.headers = { get: () => null, has: (name) => name === 'Range' && this.hasRange };
  }
}

interface FetchResult {
  handled: boolean;
  body?: string;
}

interface PutCall {
  key: string;
  vary: string | null;
  keptHeader: string | null;
}

interface Harness {
  netUp: boolean;
  netUrls: string[];
  cachedPaths(): string[];
  seed(pathname: string, body: string): number;
  fetchPath(pathname: string, opts?: FetchOpts): Promise<FetchResult>;
  cachesDeleteNames(): string[];
  /** Every cache.put call (key + the stored response's Vary/x-test headers). */
  putCalls(): PutCall[];
}

/**
 * Boot the SW script under stubs, run install + activate, and return the
 * harness. `foreignCacheName` (optional) writes entries into a FOREIGN cache
 * before install so activation's cleanup can be observed against it.
 * `swLocation` (optional) places the worker at a sub-path scope (PRR-108).
 */
async function makeHarness(
  manifest: string[],
  options: { foreignCacheName?: string; foreignEntries?: string[]; swLocation?: string } = {},
): Promise<Harness> {
  const cachesStore = new Map<string, Map<string, FakeResponse>>();
  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  const deletedCacheNames: string[] = [];
  const putRecord: PutCall[] = [];
  const harness: Harness = {
    netUp: true,
    netUrls: [],
    cachedPaths() {
      const out: string[] = [];
      for (const entries of cachesStore.values()) out.push(...entries.keys());
      return out;
    },
    seed(pathname, body) {
      let hits = 0;
      for (const entries of cachesStore.values()) {
        for (const key of [...entries.keys()]) {
          if (key === pathname) {
            entries.set(key, new FakeResponse(body));
            hits += 1;
          }
        }
      }
      return hits;
    },
    fetchPath(pathname, opts = {}) {
      const request = new FakeRequest(ORIGIN + pathname, opts);
      let settled!: (r: FakeResponse) => void;
      const result = new Promise<FakeResponse>((res) => {
        settled = res;
      });
      let handled = false;
      for (const handler of listeners.fetch ?? []) {
        handler({
          request,
          respondWith(r: unknown) {
            handled = true;
            void Promise.resolve(r).then(
              (v) => settled(v as FakeResponse),
              () => settled(new FakeResponse('', { status: 503 })),
            );
          },
          waitUntil() {},
        });
      }
      // Passthrough: the worker never called respondWith — nothing to await.
      if (!handled) return Promise.resolve<FetchResult>({ handled: false });
      return result.then((response): FetchResult => ({ handled, body: response.body }));
    },
    cachesDeleteNames() {
      return [...deletedCacheNames];
    },
    putCalls() {
      return [...putRecord];
    },
  };

  if (options.foreignCacheName !== undefined) {
    const entries = new Map<string, FakeResponse>();
    for (const url of options.foreignEntries ?? []) {
      entries.set(new URL(url, ORIGIN).pathname, new FakeResponse(`FOREIGN:${url}`));
    }
    cachesStore.set(options.foreignCacheName, entries);
  }

  const netFetch = (input: FakeRequest | string): Promise<FakeResponse> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    harness.netUrls.push(url);
    if (!harness.netUp) return Promise.reject(new TypeError('Failed to fetch (offline)'));
    // The dev/preview server emits `Vary: Origin` (the reason stripVary
    // exists); x-test rides along to prove non-Vary headers survive.
    return Promise.resolve(
      new FakeResponse(`NET:${url}`, { headers: { vary: 'Origin', 'x-test': 'keep' } }),
    );
  };

  const pathOf = (a: FakeRequest | string | URL): string => {
    const u = typeof a === 'string' ? a : (a instanceof URL ? a.href : a.url);
    try {
      return new URL(u, ORIGIN).pathname;
    } catch {
      return u;
    }
  };

  const cachesApi = {
    async open(name: string) {
      if (!cachesStore.has(name)) cachesStore.set(name, new Map());
      const entries = cachesStore.get(name) as Map<string, FakeResponse>;
      return {
        async put(a: FakeRequest | string | URL, response: FakeResponse) {
          putRecord.push({
            key: pathOf(a),
            vary: safeHeader(response, 'vary'),
            keptHeader: safeHeader(response, 'x-test'),
          });
          entries.set(pathOf(a), response);
        },
        async match(a: FakeRequest | string | URL) {
          return entries.has(pathOf(a)) ? entries.get(pathOf(a)) : undefined;
        },
        async keys() {
          return [...entries.keys()];
        },
      };
    },
    async keys() {
      return [...cachesStore.keys()];
    },
    async delete(name: string) {
      deletedCacheNames.push(name);
      return cachesStore.delete(name);
    },
    async has(name: string) {
      return cachesStore.has(name);
    },
  };

  const swSelf: Record<string, unknown> = {
    __PRECACHE_MANIFEST: manifest,
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      (listeners[type] ?? (listeners[type] = [])).push(handler);
    },
    skipWaiting() {
      return Promise.resolve();
    },
    clients: {
      claim() {
        return Promise.resolve();
      },
    },
    location: new URL(options.swLocation ?? ORIGIN + '/'),
  };
  swSelf.self = swSelf;

  const sandbox: Record<string, unknown> = {
    self: swSelf,
    caches: cachesApi,
    fetch: netFetch,
    Response: FakeResponse,
    Request: FakeRequest,
    // PRR-114(b): Headers must be present or stripVary()'s `new Headers(...)`
    // throws (silently caught) and the Vary header rides into the cache.
    Headers,
    URL,
    Promise,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(Number(ms) || 0, 5000)),
    clearTimeout,
    importScripts() {},
  };
  sandbox.globalThis = sandbox;
  const source = readFileSync(SW_PATH, 'utf8');
  new vm.Script(source, { filename: SW_PATH }).runInContext(vm.createContext(sandbox));

  const fireLifecycle = (type: string): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      for (const handler of listeners[type] ?? []) {
        handler({ waitUntil(p: unknown) {
          void Promise.resolve(p).then(settle, settle);
        } });
      }
      if (!(listeners[type] && listeners[type].length > 0)) settle();
      setTimeout(settle, 500);
    });
  await fireLifecycle('install');
  await fireLifecycle('activate');
  return harness;
}

const MANIFEST = ['/index.html', '/assets/app-4f2a9b7c.js'];

let h: Harness;

beforeEach(async () => {
  h = await makeHarness(MANIFEST);
});

describe('app-shell SW runtime policy (R4-6 precedence)', () => {
  it('passes models/, training/, api/ and auth/ requests through untouched', async () => {
    h.netUrls = []; // drop the install-time precache fetches
    for (const pathname of ['/models/llm.gguf', '/training/course/index.html', '/api/status', '/auth/session']) {
      const r = await h.fetchPath(pathname, { mode: 'no-cors', destination: 'script' });
      expect(r.handled, `${pathname} must not be handled`).toBe(false);
    }
    expect(h.netUrls).toEqual([]);
    expect(h.cachedPaths()).not.toContain('/models/llm.gguf');
  });

  it('passes pack runtime fetches, ranged requests and non-GET methods through', async () => {
    h.netUrls = [];
    expect((await h.fetchPath('/packs/runtime/abc.bin', { mode: 'no-cors' })).handled).toBe(false);
    expect((await h.fetchPath('/assets/app-4f2a9b7c.js', { range: true, mode: 'no-cors' })).handled).toBe(false);
    expect((await h.fetchPath('/assets/app-4f2a9b7c.js', { method: 'POST' })).handled).toBe(false);
    expect((await h.fetchPath('/models/weights.gguf', { method: 'HEAD' })).handled).toBe(false);
    expect(h.netUrls).toEqual([]);
  });

  it('passes player-origin.json, training-boot.html and training-boot.js through', async () => {
    for (const pathname of ['/player-origin.json', '/training-boot.html', '/training-boot.js']) {
      const r = await h.fetchPath(pathname, { mode: 'no-cors', destination: 'script' });
      expect(r.handled, `${pathname} must not be handled`).toBe(false);
    }
  });

  it('serves a navigation offline from the cached index.html fallback', async () => {
    h.netUp = false;
    const r = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(r.handled).toBe(true);
    // Install cached '/index.html' from the network; the offline navigation
    // must be answered by that cached copy, not the network.
    expect(r.body).toBe('NET:http://127.0.0.1:4174/index.html');
  });

  it('refreshes the cached index.html fallback on an online app-document navigation (R5-1)', async () => {
    // A CHANGED index at the same URL: after one online '/' navigation the
    // offline fallback must serve the FRESH document (unchanged-URL upgrade).
    h.netUp = true;
    const online = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(online.body).toBe('NET:http://127.0.0.1:4174/');
    h.netUp = false;
    const offline = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(offline.body).toBe('NET:http://127.0.0.1:4174/');
  });

  it('serves manifest members cache-first while online (no network)', async () => {
    h.netUp = true;
    h.netUrls = [];
    const r = await h.fetchPath('/assets/app-4f2a9b7c.js', { mode: 'no-cors', destination: 'script' });
    expect(r.handled).toBe(true);
    expect(r.body).toBe('NET:http://127.0.0.1:4174/assets/app-4f2a9b7c.js');
    expect(h.netUrls.some((u) => u.endsWith('/assets/app-4f2a9b7c.js'))).toBe(false);
  });

  it('never serves index.html cache-first for a non-navigation fetch (R6-5)', async () => {
    h.netUp = true;
    h.netUrls = [];
    const r = await h.fetchPath('/index.html', { mode: 'no-cors', destination: 'fetch' });
    expect(r.handled).toBe(true);
    // Online non-navigation index fetch goes to the NETWORK even though a
    // cached copy exists from install.
    expect(r.body).toBe('NET:http://127.0.0.1:4174/index.html');
    // PRR-114(a): NOW give the cached shell a DISTINCT body — with the
    // identical install-time body the old assertion could not tell cache
    // from network.
    expect(h.seed('/index.html', 'CACHED:SHELL')).toBe(1);
    // And the offline NAVIGATION fallback serves the CACHED copy (the two
    // arms really differ).
    h.netUp = false;
    const offline = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(offline.handled).toBe(true);
    expect(offline.body).toBe('CACHED:SHELL');
  });

  it('fills unmanifested assets/ chunks network-first and falls back offline afterwards (R5-8)', async () => {
    h.netUp = true;
    const first = await h.fetchPath('/assets/late-chunk-9931.js', { mode: 'no-cors', destination: 'script' });
    expect(first.body).toBe('NET:http://127.0.0.1:4174/assets/late-chunk-9931.js');
    expect(h.cachedPaths()).toContain('/assets/late-chunk-9931.js');
    h.netUp = false;
    const offline = await h.fetchPath('/assets/late-chunk-9931.js', { mode: 'no-cors', destination: 'script' });
    expect(offline.body).toBe('NET:http://127.0.0.1:4174/assets/late-chunk-9931.js');
  });

  it('PRR-108: a sub-path deployment falls back to the correctly-located precached shell', async () => {
    // The archive served under /training-app/: the worker, its manifest
    // entries and the shell all live under the scope. The hardcoded
    // '/index.html' fallback key could never find the precached
    // /training-app/index.html (origin-absolute vs SW-relative).
    const h2 = await makeHarness(['index.html', 'assets/app-4f2a9b7c.js'], {
      swLocation: `${ORIGIN}/training-app/sw.js`,
    });
    h2.netUp = false;
    const r = await h2.fetchPath('/training-app/', { mode: 'navigate', destination: 'document' });
    expect(r.handled).toBe(true);
    expect(r.body).toBe(`NET:${ORIGIN}/training-app/index.html`);
    // And an online sub-path ROOT navigation refreshes the shell under the
    // sub-path key (not the origin root's).
    h2.netUp = true;
    h2.seed('/training-app/index.html', 'CACHED:OLD');
    const online = await h2.fetchPath('/training-app/', { mode: 'navigate', destination: 'document' });
    expect(online.body).toBe(`NET:${ORIGIN}/training-app/`);
    expect(h2.cachedPaths()).toContain('/training-app/index.html');
    expect(h2.cachedPaths()).not.toContain('/index.html');
  });

  it('PRR-109: a NON-shell navigation never writes the shell key (a /documents JSON stays out of the offline shell)', async () => {
    // Seed a distinct shell body; a navigation to a non-shell path must not
    // overwrite it, and must never be written under the shell key.
    expect(h.seed('/index.html', 'CACHED:SHELL')).toBe(1);
    const putsBefore = h.putCalls().length; // drop the install-time precache puts
    h.netUp = true;
    const r = await h.fetchPath('/documents', { mode: 'navigate', destination: 'document' });
    expect(r.handled).toBe(true);
    expect(r.body).toBe(`NET:${ORIGIN}/documents`);
    // No cache.put landed on the shell key for that navigation.
    expect(h.putCalls().slice(putsBefore).filter((c) => c.key === '/index.html')).toEqual([]);
    // The distinct shell body survives.
    h.netUp = false;
    const offline = await h.fetchPath('/documents', { mode: 'navigate', destination: 'document' });
    expect(offline.body).toBe('CACHED:SHELL');
    // ...and the scope-root navigation still DOES refresh the shell key.
    h.netUp = true;
    await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(h.putCalls().slice(putsBefore).some((c) => c.key === '/index.html')).toBe(true);
  });

  it('PRR-114(b): cache.put receives a Vary-STRIPPED response (other headers preserved)', async () => {
    // The network emits Vary: Origin + x-test; every stored response must
    // have vary gone and x-test kept. Before Headers existed in the sandbox,
    // stripVary silently no-oped and the Vary header rode into the cache —
    // making stored entries unmatchable for page-initiated fetches.
    const shellPuts = h.putCalls().filter((c) => c.key === '/index.html');
    expect(shellPuts.length).toBeGreaterThanOrEqual(1); // the install precache
    for (const call of h.putCalls()) {
      expect(call.vary, `put(${call.key}) must strip Vary`).toBeNull();
      expect(call.keptHeader, `put(${call.key}) must keep x-test`).toBe('keep');
    }
    // And a navigation refresh goes through the same strip.
    h.netUp = true;
    await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    const navPut = h.putCalls().filter((c) => c.key === '/index.html').at(-1);
    expect(navPut?.vary).toBeNull();
    expect(navPut?.keptHeader).toBe('keep');
  });

  it('never deletes foreign caches on activate (R3-6)', async () => {
    // A foreign cache (webllm weights, course caches, anything not prefixed
    // docqa-shell-) predates this worker and must survive activation.
    const h2 = await makeHarness([], {
      foreignCacheName: 'foreign-cache',
      foreignEntries: ['/index.html', '/models/weights.gguf'],
    });
    expect(h2.cachesDeleteNames()).toEqual([]);
    expect(h2.cachedPaths()).toContain('/models/weights.gguf');
    // And a STALE shell cache IS deleted (only docqa-shell-* is managed):
    // after activation exactly ONE cached '/index.html' remains — the current
    // install's copy in the current shell cache.
    const h3 = await makeHarness(MANIFEST, {
      foreignCacheName: 'docqa-shell-deadbeef',
      foreignEntries: ['/index.html'],
    });
    expect(h3.cachesDeleteNames()).toContain('docqa-shell-deadbeef');
    expect(h3.cachedPaths().filter((p) => p === '/index.html')).toHaveLength(1);
  });
});
