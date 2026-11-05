/*
 * sw.js — the app-shell service worker (issue #34 item 7 via #26, plan
 * R2/R4-6/R5/R6; issue #279 plan B3 + PC-5/PC2-3/PC3-2/PC3-3).
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
 *   4. GET under the SCOPE-RELATIVE assets/ path (a late-added chunk) —
 *      network-first with cache fallback and network fill (R5-8). #279 B3:
 *      the prefix resolves against the worker's scope base (the same
 *      scope-base helper the precache and shell paths use), so a sub-path
 *      deployment (/training-app/) fills and serves /training-app/assets/**
 *      instead of passing them through.
 *   5. Everything else — passthrough.
 *
 * Cache naming: 'docqa-shell-<stamp>' where stamp is a runtime hash of the
 * SORTED manifest URL list. Activation deletes ONLY caches with this prefix —
 * foreign caches (webllm/*, course caches) are never touched (R3-6).
 *
 * Atomic precache revision (#279 B3): a precache entry that fails to fetch
 * leaves the new shell cache INCOMPLETE, marked by a sparse marker persisted in
 * a metadata cache ('docqa-meta-shell-v1') that lives OUTSIDE the CACHE_PREFIX
 * namespace (activation never deletes it, and it never serves as a shell). The
 * marker is written ONLY on failure (a cache with no marker is complete by
 * policy), refreshes on repeated failures, and is removed after a later fully
 * successful install. While the new generation is marked, activation KEEPS the
 * previous complete shell and every fetch arm serves from the newest COMPLETE
 * shell cache (shellCache()) — a partial precache can never become the offline
 * app shell.
 */
(function () {
  'use strict';

  var CACHE_PREFIX = 'docqa-shell-';
  var META_CACHE_NAME = 'docqa-meta-shell-v1';
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
  // #279 B3: the unmanifested-assets arm anchors at the scope base, the same
  // helper the precache (manifestPath) and shell paths use — '/assets/' for a
  // root-scope worker, '/training-app/assets/' under the sub-path hosting.
  var ASSETS_PATH_PREFIX = SCOPE_ROOT_PATH + 'assets/';

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

  // ---------------------------------------------------------------------------
  // Sparse incomplete-markers (#279 B3, PC-5/PC2-3/PC3-2)
  // ---------------------------------------------------------------------------

  /**
   * True when the shell cache `name` carries an incomplete-marker in the
   * metadata cache. The metadata cache is named OUTSIDE the CACHE_PREFIX
   * namespace so activation never prunes it; its entries are keyed by the
   * shell cache NAME and EXIST only for incomplete caches — no marker means
   * complete (legacy caches are complete by construction, and adoption of an
   * unmarked cache is validated entry-by-entry before it is trusted, PC3-3).
   * A metadata-cache failure reads as "not marked" (best effort).
   */
  function isMarkedIncomplete(name) {
    return caches
      .open(META_CACHE_NAME)
      .then(function (meta) {
        return meta.match(name);
      })
      .then(function (hit) {
        return hit !== undefined;
      })
      .catch(function () {
        return false;
      });
  }

  /**
   * The shell cache every fetch arm serves from (#279 B3): the current
   * generation when it is complete; otherwise the unmarked prefix cache with
   * the lexicographically greatest name — a DETERMINISTIC retained generation
   * (cache names are content hashes, not timestamps), kept by activation
   * while the current generation is marked incomplete. The metadata cache is
   * defensively excluded from the candidates by name (PC3-2): it never
   * serves as a shell. When nothing complete exists the current generation
   * is opened as a best effort.
   */
  function shellCache() {
    return caches.keys().then(function (names) {
      var shellNames = names.filter(function (name) {
        return name.indexOf(CACHE_PREFIX) === 0 && name !== META_CACHE_NAME;
      });
      return Promise.all(
        shellNames.map(function (name) {
          return isMarkedIncomplete(name).then(function (marked) {
            return marked ? null : name;
          });
        })
      ).then(function (checked) {
        var complete = checked.filter(function (name) {
          return name !== null;
        });
        if (complete.indexOf(CACHE_NAME) !== -1) return caches.open(CACHE_NAME);
        complete.sort();
        if (complete.length === 0) return caches.open(CACHE_NAME);
        return caches.open(complete[complete.length - 1]);
      });
    });
  }

  self.addEventListener('install', function (event) {
    event.waitUntil(
      (async function () {
        const meta = await caches.open(META_CACHE_NAME);
        const exists = await caches.has(CACHE_NAME);
        const marked = await meta.match(CACHE_NAME).then(
          function (hit) {
            return hit !== undefined;
          },
          function () {
            return false;
          }
        );
        if (exists && !marked) {
          // ADOPTION VALIDATION (PC3-3): the cache name is manifest-derived,
          // so an existing unmarked cache should be complete — but entry
          // count is insufficient proof (a legacy partial cache predating
          // markers may be unmarked). Validate EVERY manifest URL (the same
          // scope-relative conversion the writes use) is present; all
          // present → skip refetching, any missing → repair/rebuild below.
          const adoptable = await caches.open(CACHE_NAME);
          let missing = false;
          for (const entry of PRECACHE_LIST) {
            const hit = await adoptable.match(new URL(entry, self.location.href)).then(
              function (found) {
                return found !== undefined;
              },
              function () {
                return false;
              }
            );
            if (!hit) {
              missing = true;
              break;
            }
          }
          if (!missing) return;
        }
        // (Re)build: fetch + put each entry individually so one transient
        // failure cannot abort the whole install (addAll fails atomically);
        // the next install retries. Every entry that succeeds is cached.
        const cache = await caches.open(CACHE_NAME);
        let failures = 0;
        await Promise.all(
          PRECACHE_LIST.map(function (entry) {
            var url = new URL(entry, self.location.href);
            return fetch(url)
              .then(function (response) {
                if (!response || !response.ok) throw new Error('precache fetch failed: ' + entry);
                return cache.put(url, stripVary(response));
              })
              .catch(function (err) {
                failures += 1;
                console.warn('[sw] precache skipped:', entry, err && err.message);
              });
          })
        );
        if (failures > 0) {
          // Sparse incomplete-only marker (PC-5): metadata is written ONLY on
          // failure. A failed build/repair finishes with the marker present,
          // so activation retains the previous complete shell and every
          // fetch arm serves from it.
          await meta.put(CACHE_NAME, new Response('incomplete', { status: 200, statusText: 'incomplete-shell-marker' }));
          return;
        }
        // Full success: remove the marker ONLY if one exists (check-then-
        // delete — no unconditional entry delete, and no write on the
        // success-only path).
        const marker = await meta.match(CACHE_NAME).then(
          function (hit) {
            return hit !== undefined;
          },
          function () {
            return false;
          }
        );
        if (marker) await meta.delete(CACHE_NAME);
      })()
    );
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      (async function () {
        // #279 B3: while the new generation is marked incomplete the previous
        // complete shell must survive (the fetch arms fall back to it), so
        // pruning is skipped entirely — a later complete generation resumes
        // it. Prune ONLY this app's own stale shell caches; foreign caches
        // (webllm, course, anything else) are never touched (R3-6), and the
        // metadata cache lives outside the prefix (plus the defensive name
        // exclusion below).
        if (await isMarkedIncomplete(CACHE_NAME)) {
          console.warn('[sw] shell cache incomplete — previous generation retained:', CACHE_NAME);
        } else {
          const names = await caches.keys();
          await Promise.all(
            names.map(function (name) {
              if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME && name !== META_CACHE_NAME) {
                return caches.delete(name);
              }
              return undefined;
            })
          );
        }
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
          // The refreshed shell document belongs to the CURRENT generation
          // (CACHE_NAME), never to whichever older generation shellCache()
          // is serving while the current one is marked incomplete (#279
          // review PRR-001): writing it into the retained cache would mix
          // generations and break the offline fallback it protects.
          caches
            .open(CACHE_NAME)
            .then(function (gen) {
              return gen.put(SHELL_INDEX_PATH, stripVary(response.clone()));
            })
            .catch(function () {});
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
        shellCache().then(function (cache) {
          return handleNavigation(request, cache, path);
        })
      );
      return;
    }

    // rule 3: manifest member (index.html was consumed by rule 2) → cache-first.
    if (manifestPaths[path]) {
      event.respondWith(
        shellCache().then(function (cache) {
          return cacheFirst(request, cache);
        })
      );
      return;
    }

    // rule 4: unmanifested assets/ chunk (scope-relative, #279 B3) →
    // network-first with cache fallback + fill.
    if (path.indexOf(ASSETS_PATH_PREFIX) === 0) {
      event.respondWith(
        shellCache().then(function (cache) {
          return networkFirst(request, cache);
        })
      );
      return;
    }

    // rule 5: everything else passes through.
  });
})();
