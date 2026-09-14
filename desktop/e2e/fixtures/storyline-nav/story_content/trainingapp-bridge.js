/*
 * story_content/trainingapp-bridge.js — pack-local player bridge for the
 * TrainingApp embedded Storyline player (issue #81, D5; A8 recipe from #58).
 *
 * SHIPPED IN EVERY PACK built by packtool (loaded by exactly ONE <script>
 * tag appended to the pack's story.html). See FIXTURE_CONTRACT.md §4 and its
 * amendment history for the live-observed reasons behind the machinery.
 *
 * Why a pack-local bridge at all: the GetPlayer facade has NO jump method
 * (GetVar/SetVar only), GetVar('projectSlideNumber'|'projectSlideTitle')
 * returns null in this publish (system playervars unregistered), and the
 * renderer cannot reach the player runtime directly because app://index.html
 * and app://training/<packId>/... are distinct WHATWG hosts under the
 * standard app:// scheme. The proven mechanism (trace 02-reproduction.md §B)
 * is the internal DS runtime, reachable only from inside the player document:
 *
 *   const slide = DS.presentation.getFlatSlides().find(s => s.id === id);
 *   await DS.windowManager.requestSlideForReview(slide, '_frame');
 *   DS.windowManager.getCurrentWindowSlide() -> {id, attributes.title}
 *
 * Jumps MUST be deferred until readiness: before course start the
 * windowManager has no window and requestSlideForReview throws.
 *
 * NAVIGATION GATE (observed live in the #81 e2e, root-caused in the runtime):
 * requestSlideForReview's first stage checks the CURRENT slide's
 * `slideReady` flag. `getCurrentWindowSlide()` flips at model-load time, but
 * `slideReady` only fires on a requestAnimationFrame after the slide view's
 * html is ready. A request issued (or resolved-readback accepted) in that
 * window (a) queues behind slide.READY — pending for as long as the slide's
 * timeline runs (narration included) — and (b) sets `destroyed = true` on
 * the slide model, which makes the runtime SKIP the slide's remaining
 * trigger actions. One mistimed request therefore poisons the slide for
 * every later one. This bridge gates BOTH request issuance and jump
 * resolution on `slideReady === true`, which keeps every request on the
 * runtime's immediate synchronous path.
 */
(function () {
  'use strict';

  var READY_TIMEOUT_MS = 30000;
  var POLL_MS = 100;
  var JUMP_WINDOW_MS = 60000;
  var REQUEST_RETRY_MS = 2500;
  var UNSTICK_AFTER_MS = 4000;

  function currentSlide() {
    try {
      var wm = window.DS && window.DS.windowManager;
      if (!wm || typeof wm.getCurrentWindowSlide !== 'function') return null;
      var slide = wm.getCurrentWindowSlide();
      if (!slide || typeof slide.id !== 'string') return null;
      return {
        slideId: slide.id,
        slideTitle: (slide.attributes && slide.attributes.title) || '',
        // True only after the slide view finished mounting (its html-ready
        // requestAnimationFrame ran): the runtime's own review-request gate.
        ready: slide.slideReady === true,
      };
    } catch (err) {
      return null;
    }
  }

  function isReady() {
    var state = currentSlide();
    return state !== null && state.ready === true;
  }

  function waitForReadiness(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      if (isReady()) return resolve();
      var timer = setInterval(function () {
        if (isReady()) {
          clearInterval(timer);
          resolve();
        } else if ((waited += POLL_MS) >= timeoutMs) {
          clearInterval(timer);
          reject(new Error('trainingapp-bridge: player not ready within ' + timeoutMs + 'ms'));
        }
      }, POLL_MS);
    });
  }

  function findSlide(slideId) {
    var slides = window.DS.presentation.getFlatSlides();
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] && slides[i].id === slideId) return slides[i];
    }
    return null;
  }

  /**
   * Keep-alive window: issue the review request ONLY while the current
   * slide reports slideReady (the runtime's synchronous path) AND no
   * earlier request is still outstanding (the runtime serializes
   * navigations — piling unsettled requests deadlocks the queue), and
   * resolve only when the player's own state reports the target AND that
   * slide is ready — never earlier, or the next jump fires into the
   * not-ready window.
   */
  function jumpWindow(target, targetId) {
    return new Promise(function (resolve) {
      var waited = 0;
      var lastRequestAt = -Infinity;
      var outstanding = 0;
      var lastUnstickAt = -Infinity;
      var timer = setInterval(function () {
        waited += POLL_MS;
        var state = currentSlide();
        if (state !== null && state.ready === true && state.slideId === targetId) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        /*
         * Stuck-target recovery: the navigation LANDED (the model reports the
         * target as current) but the view's readiness rAF was eaten — under
         * PlayerMemoryEnhancements the runtime's componentWillUnmount cancels
         * every pending htmlReady requestAnimationFrame (slides.min.js,
         * htmlReadyIds.forEach(cancelAnimationFrame)), and a reconcile cycle
         * on scene entry can swallow the new slide's readiness rAF, leaving
         * slideReady permanently false. Every later review request would then
         * queue behind a slide.READY that never fires (the #81 e2e stall).
         * Setting the landed model's flag back to true restores the runtime's
         * own synchronous stage-1 path; the slide content already loaded
         * (loadedDfd resolved) and is displayed.
         */
        if (
          state !== null &&
          state.slideId === targetId &&
          state.ready !== true &&
          waited - lastUnstickAt >= UNSTICK_AFTER_MS
        ) {
          lastUnstickAt = waited;
          try {
            var wm = window.DS.windowManager;
            var model = wm.getCurrentWindowSlide();
            if (model && model.id === targetId && model.slideReady !== true) {
              model.slideReady = true;
            }
          } catch (err) {
            /* model unavailable — retry on the next unstick tick */
          }
        }
        if (outstanding === 0 && waited - lastRequestAt >= REQUEST_RETRY_MS && waited < JUMP_WINDOW_MS) {
          lastRequestAt = waited;
          var gate = currentSlide();
          if (gate !== null && gate.ready === true) {
            outstanding += 1;
            try {
              var pr = window.DS.windowManager.requestSlideForReview(target, '_frame');
              if (pr && typeof pr.then === 'function') {
                pr.then(function () { outstanding -= 1; },
                        function () { outstanding -= 1; });
                setTimeout(function () { outstanding = Math.max(0, outstanding - 1); }, 20000);
              } else {
                outstanding -= 1;
              }
            } catch (err) {
              outstanding -= 1;
            }
          }
        }
        if (waited >= JUMP_WINDOW_MS) {
          clearInterval(timer);
          resolve(false);
        }
      }, POLL_MS);
    });
  }

  /**
   * window.__trainingappJump(slideId) -> Promise<boolean>
   * true iff the player's own state subsequently reported the target slide
   * as ready. Never rejects.
   */
  function jumpToSlide(slideId) {
    if (typeof slideId !== 'string' || slideId.length === 0) {
      return Promise.resolve(false);
    }
    return waitForReadiness(READY_TIMEOUT_MS)
      .then(function () {
        var target = findSlide(slideId);
        if (!target) return false;
        return jumpWindow(target, slideId);
      })
      .catch(function () {
        return false;
      });
  }

  /** window.__trainingappState() -> Promise<{slideId, slideTitle} | null> */
  function state() {
    return Promise.resolve(currentSlide());
  }

  window.__trainingappJump = jumpToSlide;
  window.__trainingappState = state;

  /*
   * postMessage RPC (protocol: FIXTURE_CONTRACT.md §5). The renderer-side
   * bridge (web_ui/src/components/training-player-bridge.ts) sends
   * { __trainingapp: true, kind: 'jump'|'state', reqId, slideId? } and this
   * listener answers on event.source. Unknown/malformed messages are ignored.
   */
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.__trainingapp !== true) return;
    function reply(payload) {
      payload.__trainingapp = true;
      try {
        event.source.postMessage(payload, '*');
      } catch (err) {
        /* source window gone — nothing to answer */
      }
    }
    if (data.kind === 'jump') {
      jumpToSlide(data.slideId).then(function (ok) {
        reply({ kind: 'jump-result', reqId: data.reqId, ok: ok });
      });
    } else if (data.kind === 'state') {
      state().then(function (current) {
        reply({ kind: 'state-result', reqId: data.reqId, state: current });
      });
    }
  });
})();
