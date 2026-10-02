/*
 * training-boot.js — player-origin boot frame script (browser-training-parity,
 * ADR-0012). Plain ES5-style JS (served as a static file, never bundled).
 *
 *  1. Registers the course service worker /training/sw.js (scope /training/).
 *  2. Runs ONLY when its parent is the top-level page (window.parent ===
 *     window.top): the app embeds it directly, and a boot frame nested any
 *     deeper (e.g. inside course content, or inside an app instance that was
 *     itself framed) does nothing (review round 1, F1).
 *     Accepts the relay handshake ONLY from its parent window at the parent's
 *     exact origin (location.ancestorOrigins[0], else the referrer origin):
 *     { type: 'trainingapp-relay-handshake' } carrying the app-created
 *     MessagePort, and transfers that port to the ACTIVE worker.
 *  3. Forwards the worker's "I need a relay" signal to the parent (the
 *     worker loses its port when the browser stops an idle worker); the app
 *     decides whether to run a fresh handshake.
 *  4. On { type: 'trainingapp-unregister' } from the parent, unregisters the
 *     worker (the app's last pack was removed).
 * It never stores anything and is not trusted by the app.
 */
(function () {
  'use strict';

  function parentOrigin() {
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length > 0) {
        var first = location.ancestorOrigins[0];
        if (first && first !== 'null') return first;
      }
    } catch (err) {
      /* fall through to the referrer */
    }
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch (err) {
      /* no usable referrer */
    }
    return null;
  }

  function parentIsTop() {
    try {
      return window.parent !== window && window.parent === window.top;
    } catch (err) {
      return false;
    }
  }

  var expectedParent = parentOrigin();
  if (!parentIsTop() || expectedParent === null || !('serviceWorker' in navigator)) return;

  var SCOPE = '/training/';
  var hadActiveWorker = false;

  var registration = navigator.serviceWorker
    .getRegistration(SCOPE)
    .then(function (existing) {
      hadActiveWorker = !!(existing && existing.active);
      return navigator.serviceWorker.register('/training/sw.js', { scope: SCOPE });
    });

  function activeWorker(reg) {
    return new Promise(function (resolve, reject) {
      if (reg.active) {
        resolve(reg.active);
        return;
      }
      var pending = reg.installing || reg.waiting;
      if (!pending) {
        reject(new Error('no service worker to activate'));
        return;
      }
      pending.addEventListener('statechange', function onChange() {
        if (pending.state === 'activated') {
          pending.removeEventListener('statechange', onChange);
          resolve(reg.active || pending);
        } else if (pending.state === 'redundant') {
          pending.removeEventListener('statechange', onChange);
          reject(new Error('service worker became redundant'));
        }
      });
    });
  }

  function notifyParent(message) {
    try {
      window.parent.postMessage(message, expectedParent);
    } catch (err) {
      /* parent gone */
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== expectedParent || !parentIsTop()) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'trainingapp-relay-handshake' && event.ports && event.ports[0]) {
      var port = event.ports[0];
      registration
        .then(activeWorker)
        .then(function (worker) {
          worker.postMessage({ type: 'trainingapp-relay-port', hadActiveWorker: hadActiveWorker }, [port]);
        })
        .catch(function (err) {
          notifyParent({ type: 'trainingapp-boot-error', message: String((err && err.message) || err) });
        });
    } else if (data.type === 'trainingapp-unregister') {
      navigator.serviceWorker.getRegistrations().then(function (all) {
        all.forEach(function (reg) {
          reg.unregister();
        });
      });
    }
  });

  // The worker asks for a relay after it was stopped (and lost its port).
  navigator.serviceWorker.onmessage = function (event) {
    var data = event.data;
    if (data && data.type === 'trainingapp-need-relay') notifyParent({ type: 'trainingapp-relay-request' });
  };

  registration.catch(function (err) {
    notifyParent({ type: 'trainingapp-boot-error', message: String((err && err.message) || err) });
  });
})();
