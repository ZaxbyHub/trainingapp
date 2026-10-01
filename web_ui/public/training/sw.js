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
 * While no relay port exists (first start, or after the browser stopped an
 * idle worker) a request WAITS up to 10 s for one, asking the boot frame to
 * have the app run a fresh handshake; after the bound it answers 503.
 */
'use strict';

var SW_VERSION = 1;
var TRAINING_PREFIX = '/training/';
var RELAY_WAIT_MS = 10000;
var REQUEST_TIMEOUT_MS = 30000;
var READ_CHUNK_BYTES = 1024 * 1024;

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

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'trainingapp-relay-port' && event.ports && event.ports[0]) {
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

function refusal(status, text) {
  return new Response(text, {
    status: status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'no-store',
    },
  });
}

function buildResponse(result, method) {
  var headers = new Headers();
  var source = result.headers || {};
  Object.keys(source).forEach(function (name) {
    headers.set(name, String(source[name]));
  });
  // Fixed transport headers, whatever the relay said.
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  headers.set('cache-control', 'no-cache');
  var status = result.status;
  if (status === 204 || status === 304 || method === 'HEAD') return new Response(null, { status: status, headers: headers });
  if (typeof result.handle !== 'number') return new Response(result.body || '', { status: status, headers: headers });
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
      return relayRequest({ type: 'read', handle: handle, offset: offset, length: length }).then(
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
  if (url.origin !== self.location.origin || url.pathname.indexOf(TRAINING_PREFIX) !== 0 || url.pathname === '/training/sw.js') {
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
        return buildResponse(result, method);
      },
      function () {
        return refusal(503, 'Service Unavailable');
      },
    ),
  );
});
