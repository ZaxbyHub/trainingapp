/*
 * /training/sw.js — the player-origin course service worker
 * (browser-training-parity, ADR-0012). Plain JS, served as a static file.
 *
 * Serves ONLY /training/<packId>/<rest> on this (player) origin, building
 * every response from bytes relayed by the APP page over a MessagePort the
 * app created (pack bytes live only in the app origin's private storage).
 * Everything else a player client requests — other paths on this origin,
 * any other origin — is refused with 404, so course content cannot reach the
 * app shell or the network through this worker.
 *
 * The worker is stateless and untrusted: no Cache Storage, IndexedDB, OPFS
 * or localStorage; path containment, pack scoping and size/rate bounds are
 * enforced by the app-side relay (web_ui/src/lib/packs/training-relay.ts).
 *
 * The relay port is NOT trusted for security headers (final-critic round 3,
 * NC1): course JS is a same-origin client of this worker and can hand it a
 * port of its own (directly, or through the boot frame it can script), and
 * then answer the worker's requests itself. So the worker OWNS every
 * security header of a relay-served response: the course CSP (computed here,
 * in lockstep with buildBrowserTrainingCsp), COEP, CORP, COOP, nosniff and
 * cache-control. From the relay it takes only an allowlisted status, the
 * body, and content-type / content-range / accept-ranges. A course that
 * becomes its own relay can therefore only serve bytes that run under the
 * course CSP on pack paths: the same power as shipping them in its pack.
 * While no relay port exists (first start, or after the browser stopped an
 * idle worker) a request WAITS up to 10 s for one, asking the boot frame to
 * have the app run a fresh handshake; after the bound it answers 503.
 */
'use strict';

var SW_VERSION = 2;
var TRAINING_PREFIX = '/training/';
var TRAINING_SW_PATH = '/training/sw.js';
var RELAY_WAIT_MS = 10000;
var REQUEST_TIMEOUT_MS = 30000;
var READ_CHUNK_BYTES = 1024 * 1024;

// Mirror of PACK_ID_PATTERN (web_ui/src/lib/packs/training-relay.ts and
// desktop/main/protocol.ts); pinned by player-origin-hosting.test.ts.
var PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
var LOOPBACK_ALIAS = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' };

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The app origin allowed to frame course documents (frame-ancestors). The
 * boot page registers this worker as /training/sw.js?app=<its parent origin>
 * (location.ancestorOrigins[0], supplied by the browser). Nothing on the
 * player origin is unforgeable by course JS, which is same-origin with the
 * boot frame, so the value is validated and only ever WIDENS framing to one
 * origin; it never touches the content directives. Accepted: a bare http(s)
 * origin, http only for a loopback host, different from the player origin,
 * and a loopback host whenever the player is loopback. Otherwise the
 * loopback alias of the player (the bundled hosts), else null:
 * frame-ancestors 'self' only (fail closed).
 */
function workerAppOrigin(href) {
  var player = new URL(href);
  var raw = player.searchParams.get('app');
  if (raw) {
    try {
      var app = new URL(raw);
      var bare = (app.protocol === 'https:' || app.protocol === 'http:') && app.username === '' && app.password === '' &&
        app.pathname === '/' && app.search === '' && app.hash === '' && raw.replace(/\/$/, '') === app.origin;
      var schemeOk = app.protocol === 'https:' || isLoopbackHost(app.hostname);
      var loopbackOk = !isLoopbackHost(player.hostname) || isLoopbackHost(app.hostname);
      if (bare && schemeOk && loopbackOk && app.origin !== player.origin) return app.origin;
    } catch (err) {
      /* fall through */
    }
  }
  var alias = LOOPBACK_ALIAS[player.hostname];
  return alias ? player.protocol + '//' + alias + (player.port ? ':' + player.port : '') : null;
}

var PLAYER_ORIGIN = self.location.origin;
var APP_ORIGIN = workerAppOrigin(self.location.href);

/** The pack id of a /training/<packId>/... path, or null (raw segment; never decoded). */
function packIdFromPath(pathname) {
  var segment = pathname.slice(TRAINING_PREFIX.length).split('/')[0];
  return PACK_ID_PATTERN.test(segment) ? segment : null;
}

/**
 * The course CSP; in lockstep with buildBrowserTrainingCsp (training-relay.ts).
 * worker-src = courseWorkerSources: blob:, the open pack's path and this
 * worker's own script URL. Firefox lets a document controlled by this worker
 * start a dedicated worker from a URL only if the document's worker-src also
 * admits the CONTROLLING service worker's script URL (otherwise: a worker-src
 * violation naming /training/sw.js?app=..., and the worker never starts; blob:
 * workers are exempt). Admitting it gives the course nothing new: a dedicated or
 * shared worker on /training/sw.js is answered 404 by the fetch handler below,
 * and registering it was already possible through the boot frame (whose policy
 * admits exactly this URL).
 */
function courseCsp(packId) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    'worker-src ' + (packId !== null ? 'blob: ' + PLAYER_ORIGIN + TRAINING_PREFIX + packId + '/ ' + PLAYER_ORIGIN + TRAINING_SW_PATH : 'blob:'),
    "frame-src 'self'",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'frame-ancestors ' + (APP_ORIGIN !== null ? "'self' " + APP_ORIGIN : "'self'"),
  ].join('; ');
}

/** Statuses a relay may answer with; anything else (1xx, 3xx, 5xx...) becomes 502. */
var RELAY_STATUSES = { 200: true, 206: true, 403: true, 404: true, 405: true, 416: true, 429: true };
/** The only relay-supplied headers the worker passes on. */
var RELAY_HEADERS = ['content-type', 'content-range', 'accept-ranges'];

var relayPort = null;
var nextId = 1;
var pending = new Map(); // id -> { message, resolve, reject, timer }
var portWaiters = [];

function isPlayerPageClient(client) {
  try {
    var path = new URL(client.url).pathname;
    return path.indexOf(TRAINING_PREFIX) === 0;
  } catch (err) {
    return false;
  }
}

self.addEventListener('install', function (event) {
  // Version update: take over immediately only when no course is playing.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      if (!clients.some(isPlayerPageClient)) return self.skipWaiting();
      return undefined;
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function failPending(reason) {
  pending.forEach(function (entry) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  });
  pending.clear();
}

function attachPort(port) {
  if (relayPort !== null && relayPort !== port) {
    relayPort.onmessage = null;
    try {
      relayPort.close();
    } catch (err) {
      /* already closed */
    }
  }
  relayPort = port;
  port.onmessage = function (event) {
    var reply = event.data;
    if (!reply || typeof reply !== 'object' || typeof reply.id !== 'number') return;
    var entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
  };
  port.start();
  // Requests posted on a previous (now dead) port are re-sent on the new one.
  pending.forEach(function (entry) {
    port.postMessage(entry.message);
  });
  var waiters = portWaiters;
  portWaiters = [];
  waiters.forEach(function (resolve) {
    resolve(port);
  });
}

/** Defense in depth only (NC1): course JS can post through the boot frame's controller too. */
function isBootClient(source) {
  try {
    return !!source && typeof source.url === 'string' && new URL(source.url).pathname === '/training-boot.html';
  } catch (err) {
    return false;
  }
}

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'trainingapp-relay-port' && event.ports && event.ports[0] && isBootClient(event.source)) {
    var port = event.ports[0];
    attachPort(port);
    port.postMessage({ type: 'relay-ready', version: SW_VERSION, hadActiveWorker: data.hadActiveWorker === true });
  }
});

function askForRelay() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) {
      try {
        if (new URL(client.url).pathname === '/training-boot.html') client.postMessage({ type: 'trainingapp-need-relay' });
      } catch (err) {
        /* ignore */
      }
    });
  });
}

function waitForRelay() {
  if (relayPort !== null) return Promise.resolve(relayPort);
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      portWaiters = portWaiters.filter(function (w) {
        return w !== onPort;
      });
      reject(new Error('no relay'));
    }, RELAY_WAIT_MS);
    function onPort(port) {
      clearTimeout(timer);
      resolve(port);
    }
    portWaiters.push(onPort);
    askForRelay();
  });
}

function relayRequest(message) {
  return waitForRelay().then(function (port) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      message.id = id;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('relay timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { message: message, resolve: resolve, reject: reject, timer: timer });
      port.postMessage(message);
    });
  });
}

// The app relay bounds reads in flight and answers code 'busy' past it
// (review round 1, F3); back off and retry instead of failing the response.
var BUSY_RETRIES = 50;
function readWithRetry(handle, offset, length, attempt) {
  return relayRequest({ type: 'read', handle: handle, offset: offset, length: length }).then(function (reply) {
    if (reply && reply.code === 'busy' && attempt < BUSY_RETRIES) {
      return new Promise(function (resolve) {
        setTimeout(resolve, Math.min(200, 10 * (attempt + 1)));
      }).then(function () {
        return readWithRetry(handle, offset, length, attempt + 1);
      });
    }
    return reply;
  });
}

// A worker refusal is never a usable document (final-critic FC6): untrusted
// course JS can script any same-origin document it frames, so refusals (and
// any relay answer that arrives without a CSP) run under a deny-all policy
// and refuse framing.
var REFUSAL_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function refusal(status, text) {
  return new Response(text, {
    status: status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'no-store',
      'content-security-policy': REFUSAL_CSP,
      'x-frame-options': 'DENY',
    },
  });
}

function buildResponse(result, method, pathname) {
  if (!result || typeof result !== 'object' || RELAY_STATUSES[result.status] !== true) return refusal(502, 'Bad Gateway');
  // The worker's own security headers (NC1), whatever the relay said.
  var headers = new Headers({
    'content-security-policy': courseCsp(packIdFromPath(pathname)),
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
    'content-type': 'application/octet-stream',
  });
  var source = result.headers && typeof result.headers === 'object' ? result.headers : {};
  for (var i = 0; i < RELAY_HEADERS.length; i++) {
    var value = source[RELAY_HEADERS[i]];
    if (typeof value !== 'string') continue;
    try {
      headers.set(RELAY_HEADERS[i], value);
    } catch (err) {
      return refusal(502, 'Bad Gateway');
    }
  }
  var status = result.status;
  if (method === 'HEAD') return new Response(null, { status: status, headers: headers });
  if (typeof result.handle !== 'number') return new Response(typeof result.body === 'string' ? result.body : '', { status: status, headers: headers });
  var handle = result.handle;
  var offset = result.start;
  var end = result.end;
  var body = new ReadableStream({
    pull: function (controller) {
      if (offset > end) {
        controller.close();
        relayPort && relayPort.postMessage({ type: 'close', handle: handle });
        return undefined;
      }
      var length = Math.min(READ_CHUNK_BYTES, end - offset + 1);
      return readWithRetry(handle, offset, length, 0).then(
        function (reply) {
          if (reply.error || !reply.bytes) {
            controller.error(new Error(reply.error || 'relay read failed'));
            return;
          }
          var chunk = new Uint8Array(reply.bytes);
          if (chunk.byteLength !== length) {
            controller.error(new Error('relay returned a short read'));
            return;
          }
          offset += length;
          controller.enqueue(chunk);
        },
        function (err) {
          controller.error(err);
        },
      );
    },
    cancel: function () {
      relayPort && relayPort.postMessage({ type: 'close', handle: handle });
    },
  });
  return new Response(body, { status: status, headers: headers });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    event.respondWith(refusal(404, 'Not Found'));
    return;
  }
  // Player clients reach nothing but this origin's /training/ pack paths:
  // no other origin (app origin included), no app shell, no network.
  if (url.origin !== self.location.origin || url.pathname.indexOf(TRAINING_PREFIX) !== 0 || url.pathname === TRAINING_SW_PATH) {
    event.respondWith(refusal(404, 'Not Found'));
    return;
  }
  var method = request.method === 'HEAD' ? 'HEAD' : request.method === 'GET' ? 'GET' : null;
  if (method === null) {
    event.respondWith(refusal(405, 'Method Not Allowed'));
    return;
  }
  // The RAW (still percent-encoded) path: the app relay decodes and
  // validates it with the desktop resolveTrainingRequest rules.
  var rawPath = request.url.slice(url.origin.length).split('#')[0];
  event.respondWith(
    relayRequest({ type: 'open', path: rawPath, method: method, range: request.headers.get('range') }).then(
      function (result) {
        return buildResponse(result, method, url.pathname);
      },
      function () {
        return refusal(503, 'Service Unavailable');
      },
    ),
  );
});
