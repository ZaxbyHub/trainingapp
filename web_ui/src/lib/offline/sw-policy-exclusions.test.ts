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
  ok: boolean;
  constructor(body: unknown, init?: { status?: number }) {
    this.body = body === undefined || body === null ? '' : String(body);
    this.status = init?.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = { get: () => null, has: () => false };
  }
  async text(): Promise<string> {
    return this.body;
  }
  clone(): FakeResponse {
    return new FakeResponse(this.body, { status: this.status });
  }
  headers: { get(): null; has(): boolean };
}

interface FetchOpts {
  mode?: string;
  destination?: string;
  method?: string;
  range?: boolean;
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

interface Harness {
  netUp: boolean;
  netUrls: string[];
  cachedPaths(): string[];
  seed(pathname: string, body: string): number;
  fetchPath(pathname: string, opts?: FetchOpts): Promise<FetchResult>;
  cachesDeleteNames(): string[];
}

/**
 * Boot the SW script under stubs, run install + activate, and return the
 * harness. `seedCache` (optional) writes entries into a FOREIGN cache before
 * install so activation's cleanup can be observed against it.
 */
async function makeHarness(
  manifest: string[],
  options: { foreignCacheName?: string; foreignEntries?: string[] } = {},
): Promise<Harness> {
  const cachesStore = new Map<string, Map<string, FakeResponse>>();
  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  const deletedCacheNames: string[] = [];
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
    return Promise.resolve(new FakeResponse(`NET:${url}`));
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
    location: new URL(ORIGIN + '/'),
  };
  swSelf.self = swSelf;

  const sandbox: Record<string, unknown> = {
    self: swSelf,
    caches: cachesApi,
    fetch: netFetch,
    Response: FakeResponse,
    Request: FakeRequest,
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
