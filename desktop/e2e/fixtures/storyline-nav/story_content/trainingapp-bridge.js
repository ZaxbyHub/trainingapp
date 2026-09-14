/*
 * story_content/trainingapp-bridge.js — pack-local player bridge for the
 * TrainingApp embedded Storyline player (issue #81, D5; A8 recipe from #58).
 *
 * FROZEN CONTENT: committed verbatim per desktop/e2e/fixtures/storyline-nav/
 * FIXTURE_CONTRACT.md §4 (see that file's amendment history for the live-
 * observed reasons behind the navigation machinery below). Loaded by exactly
 * ONE <script> tag appended to the pack's story.html; real packs built by
 * packtool ship the same file.
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
 * Navigation reliability (observed live in the #81 e2e): the course
 * auto-plays forward, and a review jump to a slide BEHIND the current
 * playhead pends indefinitely, while a jump to a slide ahead lands as soon
 * as the current slide's timeline ends. jumpToSlide therefore (a) walks
 * behind-targets back with the player's own enabled PREV transport control
 * (never the outline/menu chrome — that is disabled in this publish and is
 * never touched), and (b) reaches ahead-targets with a keep-alive window
 * that re-issues the review request while polling the player's own state.
 */
(function () {
  'use strict';

  var READY_TIMEOUT_MS = 30000;
  var POLL_MS = 100;
  var JUMP_WINDOW_MS = 60000;
  var REQUEST_RETRY_MS = 5000;
  var WALK_STEP_BUDGET = 400;
  var WALK_STEP_TIMEOUT_MS = 4000;

  function currentSlide() {
    try {
      var wm = window.DS && window.DS.windowManager;
      if (!wm || typeof wm.getCurrentWindowSlide !== 'function') return null;
      var slide = wm.getCurrentWindowSlide();
      if (!slide || typeof slide.id !== 'string') return null;
      return {
        slideId: slide.id,
        slideTitle: (slide.attributes && slide.attributes.title) || '',
      };
    } catch (err) {
      return null;
    }
  }

  function isReady() {
    return currentSlide() !== null;
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

  function flatIndexOf(slideId) {
    var slides = window.DS.presentation.getFlatSlides();
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] && slides[i].id === slideId) return i;
    }
    return -1;
  }

  /**
   * Step back one slide with the player's enabled PREV transport control,
   * resolving true when the player's own state reports the move. Resolves
   * false when the control is disabled or the step does not register.
   */
  function walkBackwardStep() {
    return new Promise(function (resolve) {
      var state0 = currentSlide();
      var prevBtn = document.getElementById('prev');
      if (!prevBtn || /cs-disabled/.test(prevBtn.className)) return resolve(false);
      try { prevBtn.click(); } catch (err) { return resolve(false); }
      var waited = 0;
      var timer = setInterval(function () {
        var state = currentSlide();
        waited += POLL_MS;
        var moved = state !== null && state0 !== null && state.slideId !== state0.slideId;
        if (moved || waited >= WALK_STEP_TIMEOUT_MS) {
          clearInterval(timer);
          resolve(!!moved);
        }
      }, POLL_MS);
    });
  }

  function walkToSlide(targetId, budget) {
    return new Promise(function (resolve) {
      var state = currentSlide();
      if (state !== null && state.slideId === targetId) return resolve(true);
      if (budget <= 0) return resolve(false);
      walkBackwardStep().then(function (moved) {
        if (!moved) return resolve(false);
        walkToSlide(targetId, budget - 1).then(resolve, function () { resolve(false); });
      }, function () { resolve(false); });
    });
  }

  /**
   * Forward keep-alive window: re-issue the review navigation every
   * REQUEST_RETRY_MS while polling the player's own state for the target.
   * The runtime silently drops jumps issued while a slide's timeline is in
   * flight; spaced re-issues land as soon as the runtime accepts navigation.
   */
  function jumpWindow(target, targetId) {
    return new Promise(function (resolve) {
      var waited = 0;
      var lastRequestAt = -Infinity;
      var timer = setInterval(function () {
        var state = currentSlide();
        if (state !== null && state.slideId === targetId) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (waited - lastRequestAt >= REQUEST_RETRY_MS && waited < JUMP_WINDOW_MS) {
          lastRequestAt = waited;
          try {
            window.DS.windowManager.requestSlideForReview(target, '_frame');
          } catch (err) {
            /* navigation refused this tick — keep-alive will re-issue */
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
   * true iff the player's own state subsequently reported the target.
   * Never rejects.
   */
  function jumpToSlide(slideId) {
    if (typeof slideId !== 'string' || slideId.length === 0) {
      return Promise.resolve(false);
    }
    return waitForReadiness(READY_TIMEOUT_MS)
      .then(function () {
        var target = findSlide(slideId);
        if (!target) return false;
        var current = currentSlide();
        var targetIdx = flatIndexOf(slideId);
        var currentIdx = current ? flatIndexOf(current.slideId) : -1;
        var behind = currentIdx >= 0 && targetIdx >= 0 && targetIdx < currentIdx;
        if (behind) {
          return walkToSlide(slideId, WALK_STEP_BUDGET);
        }
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
   * Freeze the auto-play at first readiness: the host (TrainingPlayer) drives
   * navigation, so the course must not auto-advance past the host's targets.
   * Pausing the transport once on entry keeps every slide stable for the
   * host-driven jumps. Uses only the enabled Play/Pause transport control.
   */
  var initPauseTimer = setInterval(function () {
    if (!isReady()) return;
    clearInterval(initPauseTimer);
    try {
      var pp = document.getElementById('play-pause');
      if (pp && /pause/i.test((pp.getAttribute('aria-label') || pp.textContent || ''))) {
        pp.click();
      }
    } catch (err) {
      /* transport control absent */
    }
  }, 250);

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
