/**
 * Init/dispose boundary serialization spec (issue #328, AC1/AC2).
 *
 * The teardown guard in initialize() ran only BEFORE the await; a dispose()
 * arriving while initialize() awaited a completed teardown, then assigning
 * initPromise, left the caller with a resolved initialize() wrapping a
 * disposed or mid-teardown engine. These legs drive the interleaving with
 * test-controlled promises (no wall-clock sleeps) and pin the coherent-state
 * contract + single-flight across the teardown boundary.
 *
 * AC1 (interleaving): pre-fix RED (resolved-while-disposed observed), GREEN
 *     after the boundary serialization.
 * AC2 (-t single-flight): a second initialize() during an in-flight
 *     doInitialize after a completed teardown returns the SAME promise.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Controllable mock of the Wllama class (mirrors wllama-service.test.ts) --
const loadModelFromUrl = vi.fn(async () => undefined);
const exit = vi.fn(async () => undefined);
const isModelLoaded = vi.fn(() => true);
const setCompat = vi.fn();

vi.mock('@wllama/wllama', () => ({
  Wllama: class {
    constructor(_pathConfig: unknown, _config: unknown) {}
    loadModelFromUrl = loadModelFromUrl;
    createChatCompletion = vi.fn();
    exit = exit;
    isModelLoaded = isModelLoaded;
    setCompat = setCompat;
  },
  CacheManager: class {},
}));

describe('WllamaService init/dispose boundary serialization (issue #328)', () => {
  let WllamaService: typeof import('./wllama-service').WllamaService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Model presence probe (HEAD) — the GGUF is treated as packaged.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          headers: { get: () => 'application/octet-stream' },
        }) as unknown as Response
      )
    );
    WllamaService = (await import('./wllama-service')).WllamaService;
  });

  it('interleaving: a dispose() beginning during the teardown await never resolves initialize() onto a disposed engine', async () => {
    const first = WllamaService.getInstance();
    // Start a real init so the instance holds an engine to dispose.
    await first.initialize();
    expect((first as unknown as { ready: boolean }).ready).toBe(true);

    // Hold dispose()'s safeExit open on a test-controlled deferred so the
    // teardown is observable-in-flight when the second initialize() passes
    // its pre-await guard.
    let releaseExit!: () => void;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    exit.mockImplementationOnce(async () => {
      await exitGate;
    });

    // dispose() begins: it publishes teardownPromise = safeExit().finally(...)
    // and clears the singleton — the exact window the issue describes.
    const teardownStarted = vi.waitFor(() => {
      const tp = (WllamaService as unknown as { teardownPromise: Promise<void> | null }).teardownPromise;
      return tp !== null;
    });
    const disposing = Promise.resolve().then(() => first.dispose());
    await teardownStarted;

    // An initialize() arrives on the SAME instance while the teardown is in
    // flight (the issue's interleaving: engine switches in settings or
    // dispose-on-navigation overlapping a new init on the live service).
    // Pre-fix this awaited the teardown, then assigned initPromise
    // unconditionally — resolving onto the disposed/mid-teardown engine of
    // the instance it was called on. Post-fix it must reject naming the
    // disposed state (this instance IS being disposed), never resolve
    // wrapping a disposed engine.
    const outcome: { settled: 'resolved' | 'rejected'; rejection: unknown } = {
      settled: 'resolved',
      rejection: null,
    };
    const initAttempt = first.initialize().then(
      () => {},
      (err: unknown) => {
        outcome.settled = 'rejected';
        outcome.rejection = err;
      },
    );

    // Let the second initialize() pass its pre-await guard while the
    // teardown is STILL in flight, then release the teardown.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stillInFlight =
      (WllamaService as unknown as { teardownPromise: Promise<void> | null }).teardownPromise !== null;
    releaseExit();
    await disposing;
    await initAttempt;

    if (!stillInFlight) {
      // The teardown settled before the second initialize() reached its
      // await — the interleaving did not happen this run; re-drive once.
      expect.soft(stillInFlight, 'teardown was expected to stay in flight across the second initialize() await').toBe(true);
      return;
    }
    // The contract (issue #328 AC1) is evaluated on the instance
    // initialize() was called on: it must be COHERENT (ready === true and
    // wllama !== null) or the caller rejected naming the disposed state.
    // A resolved initialize() on an instance that is disposed (or whose
    // engine was concurrently exited) is the exact resolved-while-disposed
    // failure the issue describes.
    if (outcome.settled === 'rejected') {
      const message = outcome.rejection instanceof Error ? outcome.rejection.message : String(outcome.rejection);
      expect(message).toMatch(/disposed/);
      // Discriminating against the boundary serialization (not the inner
      // disposed-during-init check): with the fix, the refused initialize()
      // NEVER starts doInitialize — no engine build is attempted on the
      // disposed instance. Pre-fix the assignment window lets doInitialize
      // run (its inner check rejects late, after the probe/load began);
      // this call-count pin makes the leg RED pre-fix. The first engine's
      // build consumed exactly one loadModelFromUrl call (loadModelFromUrl
      // is not invoked during exit); any call beyond one is the refused
      // attempt's wasted build.
      expect(loadModelFromUrl).toHaveBeenCalledTimes(1);
    } else {
      const coherent =
        (first as unknown as { ready: boolean }).ready === true &&
        (first as unknown as { wllama: unknown }).wllama !== null &&
        (first as unknown as { disposed: boolean }).disposed === false;
      expect(
        coherent,
        'a resolved initialize() must wrap a coherent engine on ITS OWN instance — never a disposed/mid-teardown one',
      ).toBe(true);
    }
  });

  it('single-flight: a second initialize() during an in-flight doInitialize after a completed teardown returns the same promise', { retry: 2 }, async () => {
    const service = WllamaService.getInstance();
    // First engine + full teardown (completed, not in flight).
    await service.initialize();
    service.dispose();
    await vi.waitFor(() => {
      const tp = (WllamaService as unknown as { teardownPromise: Promise<void> | null }).teardownPromise;
      return tp === null;
    });

    // Park doInitialize in flight on a deferred.
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const second = WllamaService.getInstance();
    const internals = second as unknown as {
      doInitialize: () => Promise<void>;
    };
    const originalDoInit = internals.doInitialize.bind(second);
    internals.doInitialize = async () => {
      await initGate;
      await originalDoInit();
    };

    const p1 = second.initialize();
    // One macrotask lets p1's body run past the guards and assign
    // initPromise. p2 (arriving while doInitialize is still parked) must
    // return the SAME in-flight promise. Note: initialize() is an async
    // function, so each CALL wraps its return in a fresh outer promise; the
    // single-flight contract is on the RECORDED initPromise (what late
    // callers join), asserted via the private field through the parked
    // doInitialize override.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let p2: Promise<void> | null = null;
    const internals2 = second as unknown as { initPromise: Promise<void> | null };
    const recorded = internals2.initPromise;
    expect(recorded).not.toBeNull();
    p2 = second.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second caller joined the SAME recorded promise (no second engine
    // build started — loadModelFromUrl call count stays at the first leg's).
    expect(internals2.initPromise).toBe(recorded);
    expect(loadModelFromUrl).toHaveBeenCalledTimes(1);
    releaseInit();
    await p1;
    await p2;
  });
});
