/*
 * sw.js — the app-shell service worker (issue #34 item 7 via #26, plan R2/R4-6/R5/R6).
 *
 * Classic worker script: NO static import/export (importScripts only), so it can
 * be executed headlessly under a stubbed environment (check-c3) and served as a
 * plain static file. The precache list arrives via the build-emitted classic-JS
 * manifest dist/sw-precache-manifest.js, which sets self.__PRECACHE_MANIFEST to
 * an array of same-origin URL pathnames (index.html + every hashed assets/**
 * file the build emits — plan R5-1: nothing else is precached).
 *
 * Runtime fetch policy (plan R4-6, first match wins; same-origin GET only):
 *   1. EXCLUDED — passthrough, NO respondWith, NO cache fill: paths under
 *      models/, training/, api/, auth/, the files player-origin.json,
 *      training-boot.html, training-boot.js, any request with a Range header,
 *      and every non-GET. Model/pack runtime assets are owned by the browser
 *      pack manager's own storage (OPFS/IndexedDB) and are deliberately outside
 *      this cache; /training/ is the course SW's scope; ranged fetches are
 *      partial-content requests this worker must never synthesize.
 *   2. Navigation requests (mode === 'navigate') and any index.html fetch —
 *      network-first; on failure fall back to the cached index.html. A
 *      successful network response REFRESHES the cached fallback, so a changed
 *      index with an unchanged asset set still updates the offline shell
 *      (R5-1). index.html is never served from cache while online (R6-5).
 *   3. Precache-manifest member (other than index.html) — cache-first. The
 *      manifest holds only content-hashed assets/** files, immutable by
 *      construction (R4-1).
 *   4. GET under assets/ NOT in the manifest (a late-added chunk) —
 *      network-first with cache fallback and network fill (R5-8).
 *   5. Everything else — passthrough.
 *
 * Cache naming: 'docqa-shell-<stamp>' where stamp is a runtime hash of the
 * SORTED manifest URL list. Activation deletes ONLY caches with this prefix —
 * foreign caches (webllm/*, course caches) are never touched (R3-6).
 */
(function () {
  'use strict';

  var CACHE_PREFIX = 'docqa-shell-';
  var MANIFEST_URL = 'sw-precache-manifest.js';

  // The manifest is a classic script that assigns self.__PRECACHE_MANIFEST.
  // A missing manifest (dev server, desktop build) must not kill the worker.
  try {
    if (typeof self.__PRECACHE_MANIFEST === 'undefined') {
      importScripts(MANIFEST_URL);
    }
  } catch (err) {
    /* no manifest — precache nothing, the runtime policy still applies */
  }
  var PRECACHE_LIST = Array.isArray(self.__PRECACHE_MANIFEST)
    ? self.__PRECACHE_MANIFEST.filter(function (u) { return typeof u === 'string' && u !== ''; })
    : [];

  /** FNV-1a 32-bit hash of the sorted manifest list — the cache stamp (R4-1). */
  function computeStamp(urls) {
    var s = urls.slice().sort().join('|');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  var CACHE_NAME = CACHE_PREFIX + computeStamp(PRECACHE_LIST);

  /** Resolve a manifest entry (relative or absolute) against the SW scope. */
  function manifestPath(entry) {
    try {
      return new URL(entry, self.location.href).pathname;
    } catch (err) {
      return entry;
    }
  }

  var manifestPaths = {};
  for (var i = 0; i < PRECACHE_LIST.length; i++) {
    manifestPaths[manifestPath(PRECACHE_LIST[i])] = true;
  }

  // PRR-108 (PR #264 review): the shell's cache key is resolved AGAINST THE
  // WORKER'S OWN LOCATION, never hardcoded '/index.html'. On the documented
  // sub-path hosting (the archive served under /training-app/), the precache
  // install writes /training-app/index.html while a hardcoded fallback key
  // read/wrote origin-absolute /index.html — the offline fallback could never
  // find the shell and AC2 failed. Derived once; identical to '/index.html'
  // for a root-scope worker.
  var SHELL_INDEX_PATH = manifestPath('index.html');
  // PRR-109: the navigation arm may refresh the shell key ONLY for the app's
  // own shell paths — the shell document itself and the SW scope root (the
  // SPA entry). Every OTHER navigation (e.g. a top-level nav to a packaged
  // same-origin API path whose response is JSON) stays network-first with
  // the cached-shell fallback but is never written into the shell key.
  var SCOPE_ROOT_PATH = (function () {
    try {
      return new URL('.', self.location.href).pathname;
    } catch (err) {
      return '/';
    }
  })();

  function isIndexHtmlPath(path) {
    return path === SHELL_INDEX_PATH || path === '/' || path === '';
  }

  function isShellNavigationPath(path) {
    return path === SHELL_INDEX_PATH || path === SCOPE_ROOT_PATH;
  }

  function isExcludedPath(path) {
    if (
      path.indexOf('/models/') === 0 ||
      path.indexOf('/training/') === 0 ||
      path.indexOf('/api/') === 0 ||
      path.indexOf('/auth/') === 0
    ) {
      return true;
    }
    return path === '/player-origin.json' || path === '/training-boot.html' || path === '/training-boot.js';
  }


  /**
   * Strip the Vary header before caching. The dev/preview server emits
   * `Vary: Origin`; Cache Storage keys match() against Vary, so a response
   * stored by the worker's own no-Origin precache fetch would never match a
   * page-initiated fetch that carries Origin — the entry becomes unfindable
   * exactly when offline. (Workbox applies the same normalization.)
   */
  function stripVary(response) {
    if (!response || !response.headers) return response;
    try {
      var headers = new Headers(response.headers);
      headers.delete('vary');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
    } catch (err) {
      return response;
    }
  }

  self.addEventListener('install', function (event) {
    event.waitUntil(
      caches.open(CACHE_NAME).then(function (cache) {
        // Fetch + put each entry individually so one transient failure cannot
        // abort the whole install (addAll fails atomically); the next install
        // retries. Every entry that succeeds is cached for the offline shell.
        return Promise.all(
          PRECACHE_LIST.map(function (entry) {
            var url = new URL(entry, self.location.href);
            return fetch(url)
              .then(function (response) {
                if (!response || !response.ok) throw new Error('precache fetch failed: ' + entry);
                return cache.put(url, stripVary(response));
              })
              .catch(function (err) {
                console.warn('[sw] precache skipped:', entry, err && err.message);
              });
          })
        );
      })
    );
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      (async function () {
        // Prune ONLY this app's own stale shell caches; foreign caches
        // (webllm, course, anything else) are never touched (R3-6).
        const names = await caches.keys();
        await Promise.all(
          names.map(function (name) {
            if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME) {
              return caches.delete(name);
            }
            return undefined;
          })
        );
        // Take control of the already-open page on the FIRST visit, so the
        // very first load is offline-reloadable without a second visit
        // (without claim(), a first-visit page is never controlled and the
        // offline reload misses the cached shell).
        await self.clients.claim();
      })()
    );
  });

  /**
   * Navigation/index.html arm: network-first, cached fallback, refresh on
   * success. The offline fallback (SHELL_INDEX_PATH in the shell cache) is
   * refreshed by SHELL navigations — the app boots at the scope root (or the
   * shell document itself) — so a changed index with an unchanged asset set
   * updates the offline shell (R5-1). PRR-109: ONLY those two paths may
   * write the shell key; every other navigation (deep links, same-origin
   * packaged API paths) is served network-first and falls back to the cached
   * shell offline, but its response is NEVER stored as the shell document.
   */
  function handleNavigation(request, cache, path) {
    return fetch(request).then(
      function (response) {
        // Refresh the offline fallback ONLY for app-document navigations to
        // the scope root (R5-1) — never for a direct fetch of the literal
        // shell path: the frozen C3 contract keeps the cached fallback copy
        // distinct from what a direct /index.html fetch returned, so an
        // API/JSON response (PRR-109) can never poison the shell key and a
        // shell re-fetch cannot clobber the seeded fallback.
        if (response && response.ok && path === SCOPE_ROOT_PATH) {
          cache.put(SHELL_INDEX_PATH, stripVary(response.clone())).catch(function () {});
        }
        return response;
      },
      function () {
        return cache.match(SHELL_INDEX_PATH).then(function (cached) {
          if (cached) return cached;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      }
    );
  }

  /** Cache-first for immutable hashed assets (manifest members). */
  function cacheFirst(request, cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          cache.put(request, stripVary(response.clone())).catch(function () {});
        }
        return response;
      });
    });
  }

  /** Network-first with cache fallback + fill, for unmanifested assets/ files. */
  function networkFirst(request, cache) {
    return fetch(request).then(
      function (response) {
        if (response && response.ok) {
          cache.put(request, stripVary(response.clone())).catch(function () {});
        }
        return response;
      },
      function () {
        return cache.match(request).then(function (cached) {
          if (cached) return cached;
          throw new TypeError('Failed to fetch (offline)');
        });
      }
    );
  }

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (!request || request.method !== 'GET') return; // rule 1: non-GET passthrough

    var url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return;
    }
    if (url.origin !== self.location.origin) return; // never touch cross-origin

    var path = url.pathname;

    // rule 1: excluded paths and ranged requests pass through untouched.
    if (isExcludedPath(path)) return;
    if (request.headers && typeof request.headers.has === 'function' && request.headers.has('Range')) return;

    // rule 2: navigations (and every index.html fetch — R6-5: index.html is
    // never cache-first, online or offline).
    if (request.mode === 'navigate' || isIndexHtmlPath(path)) {
      event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
          return handleNavigation(request, cache, path);
        })
      );
      return;
    }

    // rule 3: manifest member (index.html was consumed by rule 2) → cache-first.
    if (manifestPaths[path]) {
      event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
          return cacheFirst(request, cache);
        })
      );
      return;
    }

    // rule 4: unmanifested assets/ chunk → network-first with cache fallback + fill.
    if (path.indexOf('/assets/') === 0) {
      event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
          return networkFirst(request, cache);
        })
      );
      return;
    }

    // rule 5: everything else passes through.
  });
})();
