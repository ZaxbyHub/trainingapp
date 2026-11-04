/**
 * sw-precache-atomic (issue #279 AC4, check C11): the app-shell service
 * worker's ATOMIC precache revision — a failed precache entry can never
 * leave a partial cache serving as the offline shell.
 *
 * RED at base, GREEN after the fix (#279 B3 + PC-5/PC2-3/PC3-2/PC3-3): at
 * base a failed entry was skipped, activation pruned the previous complete
 * cache anyway, and every fetch arm opened CACHE_NAME unconditionally — the
 * offline shell went missing exactly when it was needed. After the fix the
 * failure persists a sparse incomplete-marker into a metadata cache outside
 * the CACHE_PREFIX namespace (never pruned, never a shell), activation
 * retains the previous complete generation, every fetch arm resolves the
 * newest COMPLETE shell, adoption of an unmarked cache is validated
 * entry-by-entry, and a later fully-successful install removes the marker
 * and resumes pruning.
 *
 * The vm harness is a COPY of sw-policy-exclusions.test.ts's makeHarness
 * (that spec stays unedited — its harness is not exported), EXTENDED with:
 * metadata-cache delete support, per-URL fetch failure injection, legacy
 * cache seeding, per-cache entry inspection, and a persistent reboot that
 * re-runs the worker in a fresh vm over the SAME Cache Storage map.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SW_PATH = path.resolve(__dirname, '../../../public/sw.js');
const ORIGIN = 'http://127.0.0.1:4174';
const META_CACHE_NAME = 'docqa-meta-shell-v1';
const CACHE_PREFIX = 'docqa-shell-';

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

interface SeededCache {
  name: string;
  entries: string[];
}

interface Harness {
  netUp: boolean;
  netUrls: string[];
  /** URLs whose network fetch answers 503 (precache failure injection). */
  failUrls: string[];
  cachedPaths(): string[];
  seed(pathname: string, body: string): number;
  fetchPath(pathname: string, opts?: FetchOpts): Promise<FetchResult>;
  cachesDeleteNames(): string[];
  putCalls(): PutCall[];
  /** Every cache name currently in Cache Storage. */
  cacheNames(): string[];
  /** The entry keys of one named cache (empty when absent). */
  cacheEntries(name: string): string[];
  /** True when the metadata cache holds an incomplete-marker for `name`. */
  markerPresent(name: string): boolean;
  /** Re-run the worker in a fresh vm over the SAME persistent caches. */
  reboot(): Promise<void>;
}

/**
 * Boot the SW script under stubs, run install + activate, and return the
 * harness. Mirrors sw-policy-exclusions.test.ts's makeHarness (a copy — the
 * original stays unedited) extended with `seedCaches` (legacy caches created
 * before the worker runs), `failUrls` (503 injection), metadata-delete
 * support, per-cache inspection and persistent reboot.
 */
async function makeHarness(
  manifest: string[],
  options: { seedCaches?: SeededCache[]; failUrls?: string[]; swLocation?: string } = {},
): Promise<Harness> {
  const cachesStore = new Map<string, Map<string, FakeResponse>>();
  let listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  const deletedCacheNames: string[] = [];
  const putRecord: PutCall[] = [];

  const bodyForSeededEntry = (cacheName: string, pathname: string): string =>
    `PREVCACHE:${cacheName}:${pathname}`;

  for (const seeded of options.seedCaches ?? []) {
    const entries = new Map<string, FakeResponse>();
    for (const pathname of seeded.entries) {
      entries.set(pathname, new FakeResponse(bodyForSeededEntry(seeded.name, pathname)));
    }
    cachesStore.set(seeded.name, entries);
  }

  const harness: Harness = {
    netUp: true,
    netUrls: [],
    failUrls: [...(options.failUrls ?? [])],
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
      if (!handled) return Promise.resolve<FetchResult>({ handled: false });
      return result.then((response): FetchResult => ({ handled, body: response.body }));
    },
    cachesDeleteNames() {
      return [...deletedCacheNames];
    },
    putCalls() {
      return [...putRecord];
    },
    cacheNames() {
      return [...cachesStore.keys()];
    },
    cacheEntries(name) {
      return [...(cachesStore.get(name)?.keys() ?? [])];
    },
    markerPresent(name) {
      const meta = cachesStore.get(META_CACHE_NAME);
      return meta !== undefined && meta.has(new URL(name, ORIGIN).pathname);
    },
    reboot() {
      return runWorker();
    },
  };

  const netFetch = (input: FakeRequest | string): Promise<FakeResponse> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    harness.netUrls.push(url);
    if (!harness.netUp) return Promise.reject(new TypeError('Failed to fetch (offline)'));
    if (harness.failUrls.includes(url)) {
      return Promise.resolve(new FakeResponse('SERVICE UNAVAILABLE', { status: 503 }));
    }
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
        async delete(a: FakeRequest | string | URL) {
          return entries.delete(pathOf(a));
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

  async function runWorker(): Promise<void> {
    listeners = {};
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
  }

  await runWorker();
  return harness;
}

/** Mirrors sw.js's computeStamp so the specs can derive CACHE_NAME. */
function computeStampForTest(urls: string[]): string {
  const s = urls.slice().sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const cacheNameFor = (urls: string[]): string => CACHE_PREFIX + computeStampForTest(urls);

const MANIFEST = ['/index.html', '/assets/app-4f2a9b7c.js'];
const MANIFEST_V2 = ['/index.html', '/assets/app-4f2a9b7c.js', '/assets/extra-9931.js'];
const CACHE_CURRENT = cacheNameFor(MANIFEST);
const CACHE_V2 = cacheNameFor(MANIFEST_V2);
const FAILING_ASSET = `${ORIGIN}/assets/extra-9931.js`;
const PREV_CACHE = 'docqa-shell-prev';

/** The retained previous generation, seeded complete for both manifests. */
const PREVIOUS_COMPLETE: SeededCache = {
  name: PREV_CACHE,
  entries: ['/index.html', '/assets/app-4f2a9b7c.js', '/assets/extra-9931.js'],
};

const prevBody = (pathname: string): string => `PREVCACHE:${PREV_CACHE}:${pathname}`;

describe('atomic precache revision (issue #279 B3)', () => {
  it('a failed precache entry marks the new shell incomplete and keeps the previous complete shell serving offline', async () => {
    const h = await makeHarness(MANIFEST_V2, {
      seedCaches: [PREVIOUS_COMPLETE],
      failUrls: [FAILING_ASSET],
    });
    // The new generation exists but is marked incomplete; the metadata cache
    // is present by name; activation retained the previous generation.
    expect(h.cacheNames()).toContain(CACHE_V2);
    expect(h.cacheNames()).toContain(PREV_CACHE);
    expect(h.cacheNames()).toContain(META_CACHE_NAME);
    expect(h.markerPresent(CACHE_V2)).toBe(true);
    expect(h.cachesDeleteNames()).not.toContain(PREV_CACHE);
    // Offline, the navigation and the failed manifest asset both serve from
    // the RETAINED previous complete cache — the partial new cache never
    // becomes the shell.
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.handled).toBe(true);
    expect(nav.body).toBe(prevBody('/index.html'));
    const asset = await h.fetchPath('/assets/extra-9931.js', { mode: 'no-cors', destination: 'script' });
    expect(asset.handled).toBe(true);
    expect(asset.body).toBe(prevBody('/assets/extra-9931.js'));
    // The metadata cache holds ONLY the marker key — it is never opened as a
    // shell (no shell paths inside it).
    expect(h.cacheEntries(META_CACHE_NAME)).toEqual([new URL(CACHE_V2, ORIGIN).pathname]);
  });

  it('an unchanged manifest: install validates the existing unmarked cache and skips refetching', async () => {
    const h = await makeHarness(MANIFEST);
    expect(h.cacheNames()).toContain(CACHE_CURRENT);
    // Drop the install-time fetches, then reboot the SAME worker over the
    // SAME persistent caches: the unmarked CACHE_NAME passes adoption
    // validation (every manifest entry present) and nothing is refetched.
    h.netUrls = [];
    await h.reboot();
    expect(h.netUrls).toEqual([]);
    expect(h.markerPresent(CACHE_CURRENT)).toBe(false);
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.handled).toBe(true);
    expect(nav.body).toBe(`NET:${ORIGIN}/index.html`);
  });

  it('repeated failures keep the marker across activation and a persistent reboot', async () => {
    const h = await makeHarness(MANIFEST_V2, {
      seedCaches: [PREVIOUS_COMPLETE],
      failUrls: [FAILING_ASSET],
    });
    expect(h.markerPresent(CACHE_V2)).toBe(true);
    // Reboot (a worker restart over the same Cache Storage): the marked cache
    // is rebuilt, fails again, and the marker is refreshed — never certified
    // complete after another failure. The previous generation survives the
    // reboot's activation too.
    await h.reboot();
    expect(h.markerPresent(CACHE_V2)).toBe(true);
    expect(h.cacheNames()).toContain(PREV_CACHE);
    expect(h.cachesDeleteNames()).not.toContain(PREV_CACHE);
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.body).toBe(prevBody('/index.html'));
  });

  it('a later fully-successful install removes the marker and resumes pruning', async () => {
    const h = await makeHarness(MANIFEST_V2, {
      seedCaches: [PREVIOUS_COMPLETE],
      failUrls: [FAILING_ASSET],
    });
    expect(h.markerPresent(CACHE_V2)).toBe(true);
    // The failure heals: the next install rebuilds every entry successfully,
    // removes the marker (check-then-delete), and activation prunes the
    // retained previous generation again — the current cache serves.
    h.failUrls.splice(0, h.failUrls.length);
    await h.reboot();
    expect(h.markerPresent(CACHE_V2)).toBe(false);
    expect(h.cachesDeleteNames()).toContain(PREV_CACHE);
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.body).toBe(`NET:${ORIGIN}/index.html`);
  });

  it('adoption validation repairs a partial UNMARKED legacy cache (entry count is insufficient proof)', async () => {
    // A legacy partial cache under the CURRENT name: it predates markers, so
    // it is unmarked — but one manifest entry is missing. Install must
    // detect the gap and repair (refetch), not trust the name.
    const h = await makeHarness(MANIFEST, {
      seedCaches: [{ name: CACHE_CURRENT, entries: ['/index.html'] }],
    });
    expect(h.cacheEntries(CACHE_CURRENT)).toContain('/index.html');
    expect(h.cacheEntries(CACHE_CURRENT)).toContain('/assets/app-4f2a9b7c.js');
    expect(h.netUrls).toContain(`${ORIGIN}/assets/app-4f2a9b7c.js`);
    expect(h.markerPresent(CACHE_CURRENT)).toBe(false);
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.body).toBe(`NET:${ORIGIN}/index.html`);
  });

  it('a FAILED repair of a partial unmarked legacy cache marks it incomplete and retains the previous complete cache', async () => {
    const h = await makeHarness(MANIFEST, {
      seedCaches: [
        { name: CACHE_CURRENT, entries: ['/index.html'] },
        { name: PREV_CACHE, entries: ['/index.html', '/assets/app-4f2a9b7c.js'] },
      ],
      failUrls: [`${ORIGIN}/assets/app-4f2a9b7c.js`],
    });
    // The repair failed: the marker lands on the current cache and the
    // previous complete generation serves offline.
    expect(h.markerPresent(CACHE_CURRENT)).toBe(true);
    expect(h.cacheNames()).toContain(PREV_CACHE);
    expect(h.cachesDeleteNames()).not.toContain(PREV_CACHE);
    h.netUp = false;
    const nav = await h.fetchPath('/', { mode: 'navigate', destination: 'document' });
    expect(nav.handled).toBe(true);
    expect(nav.body).toBe(prevBody('/index.html'));
  });
});
