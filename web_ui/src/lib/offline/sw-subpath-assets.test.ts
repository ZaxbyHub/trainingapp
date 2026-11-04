/**
 * sw-subpath-assets (issue #279 AC5, check C12): the unmanifested-assets
 * arm resolves '/assets/' against the WORKER'S SCOPE BASE (the same
 * scope-base helper the precache and shell paths use), so a sub-path
 * deployment (the archive served under /training-app/) fills and serves
 * /training-app/assets/** late chunks instead of passing them through.
 *
 * RED at base, GREEN after the fix (#279 B3): at base rule 4 anchored at
 * the ORIGIN ROOT ('/assets/'), so a sub-path worker passed its own
 * scope-relative asset chunks through untouched — no offline fallback for
 * exactly the chunks a sub-path deployment lazy-loads. The harness is a
 * copy of sw-policy-exclusions.test.ts's makeHarness with swLocation under
 * /training-app/sw.js (that spec stays unedited; its harness is not
 * exported). The origin-root leg keeps the root-scope behavior unchanged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

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
  fetchPath(pathname: string, opts?: FetchOpts): Promise<FetchResult>;
}

/** A copy of sw-policy-exclusions.test.ts's makeHarness (unedited there). */
async function makeHarness(
  manifest: string[],
  options: { swLocation?: string } = {},
): Promise<Harness> {
  const cachesStore = new Map<string, Map<string, FakeResponse>>();
  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};

  const harness: Harness = {
    netUp: true,
    netUrls: [],
    cachedPaths() {
      const out: string[] = [];
      for (const entries of cachesStore.values()) out.push(...entries.keys());
      return out;
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
      if (!handled) return Promise.resolve<FetchResult>({ handled: false });
      return result.then((response): FetchResult => ({ handled, body: response.body }));
    },
  };

  const netFetch = (input: FakeRequest | string): Promise<FakeResponse> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    harness.netUrls.push(url);
    if (!harness.netUp) return Promise.reject(new TypeError('Failed to fetch (offline)'));
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

describe('scope-relative unmanifested assets arm (issue #279 B3, rule 4)', () => {
  it('a sub-path worker fills /training-app/assets/** late chunks and serves them offline', async () => {
    const h = await makeHarness(['index.html', 'assets/app-4f2a9b7c.js'], {
      swLocation: `${ORIGIN}/training-app/sw.js`,
    });
    // Online: the scope-relative late chunk is handled (network-first) and
    // filled into the shell cache under its sub-path key.
    const first = await h.fetchPath('/training-app/assets/late-chunk-9931.js', {
      mode: 'no-cors',
      destination: 'script',
    });
    expect(first.handled).toBe(true);
    expect(first.body).toBe(`NET:${ORIGIN}/training-app/assets/late-chunk-9931.js`);
    expect(h.cachedPaths()).toContain('/training-app/assets/late-chunk-9931.js');
    // Offline: served from the cache.
    h.netUp = false;
    const offline = await h.fetchPath('/training-app/assets/late-chunk-9931.js', {
      mode: 'no-cors',
      destination: 'script',
    });
    expect(offline.handled).toBe(true);
    expect(offline.body).toBe(`NET:${ORIGIN}/training-app/assets/late-chunk-9931.js`);
    // The precached sub-path manifest member still serves cache-first.
    const precached = await h.fetchPath('/training-app/assets/app-4f2a9b7c.js', {
      mode: 'no-cors',
      destination: 'script',
    });
    expect(precached.handled).toBe(true);
    expect(precached.body).toBe(`NET:${ORIGIN}/training-app/assets/app-4f2a9b7c.js`);
  });

  it('origin-root /assets/ behavior is unchanged for a root-scope worker', async () => {
    const h = await makeHarness(['/index.html', '/assets/app-4f2a9b7c.js']);
    const first = await h.fetchPath('/assets/late-chunk-9931.js', {
      mode: 'no-cors',
      destination: 'script',
    });
    expect(first.handled).toBe(true);
    expect(first.body).toBe(`NET:${ORIGIN}/assets/late-chunk-9931.js`);
    expect(h.cachedPaths()).toContain('/assets/late-chunk-9931.js');
    h.netUp = false;
    const offline = await h.fetchPath('/assets/late-chunk-9931.js', {
      mode: 'no-cors',
      destination: 'script',
    });
    expect(offline.handled).toBe(true);
    expect(offline.body).toBe(`NET:${ORIGIN}/assets/late-chunk-9931.js`);
  });
});
