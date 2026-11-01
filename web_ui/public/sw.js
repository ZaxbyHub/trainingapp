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

  function isIndexHtmlPath(path) {
    return path === '/index.html' || path === '/' || path === '';
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
                return cache.put(url, response);
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
      caches.keys().then(function (names) {
        return Promise.all(
          names.map(function (name) {
            // Delete ONLY this app's own stale shell caches; foreign caches
            // (webllm, course, anything else) are never touched (R3-6).
            if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME) {
              return caches.delete(name);
            }
            return undefined;
          })
        );
      })
    );
  });

  /**
   * Navigation/index.html arm: network-first, cached fallback, refresh on
   * success. The offline fallback ('/index.html' in the shell cache) is
   * refreshed by APP-DOCUMENT navigations — the app boots at '/' (or a deep
   * link) — so a changed index with an unchanged asset set updates the
   * offline shell (R5-1). A direct document fetch of the literal /index.html
   * path is served network-first like every navigation but does not rewrite
   * the fallback copy.
   */
  function handleNavigation(request, cache, path) {
    return fetch(request).then(
      function (response) {
        if (response && response.ok && path !== '/index.html') {
          // Refresh the offline fallback with the fresh document (R5-1). The
          // clone is consumed by put; the original goes back to the page.
          cache.put('/index.html', response.clone()).catch(function () {});
        }
        return response;
      },
      function () {
        return cache.match('/index.html').then(function (cached) {
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
          cache.put(request, response.clone()).catch(function () {});
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
          cache.put(request, response.clone()).catch(function () {});
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
