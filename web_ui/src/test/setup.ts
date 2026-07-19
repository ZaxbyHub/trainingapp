/**
 * Centralized Vitest setup.
 *
 * Registers `@testing-library/jest-dom` matchers (`toBeInTheDocument`, etc.) and
 * the vitest-specific type augmentation once, so individual test files don't
 * need a per-file `import '@testing-library/jest-dom'` side-effect (which is
 * fragile and was previously the only registration mechanism).
 *
 * Wired via `vitest.config.ts` `setupFiles: ['./src/test/setup.ts']`.
 */
import '@testing-library/jest-dom/vitest';

// jsdom does not implement `matchMedia`, which several components query during
// render. Provide a no-op stub so tests that touch responsive/theme code don't
// throw on the missing API.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom lacks `IntersectionObserver`; stub it for components that observe
// visibility (e.g. lazy message lists).
if (typeof window !== 'undefined' && !('IntersectionObserver' in window)) {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
  }
  type IntersectionObserverCtor = new (
    callback: unknown,
    options?: unknown
  ) => {
    observe(): void;
    unobserve(): void;
    disconnect(): void;
    takeRecords(): unknown[];
    readonly root: unknown;
    readonly rootMargin: string;
    readonly thresholds: number[];
  };
  const ctor = IntersectionObserverStub as unknown as IntersectionObserverCtor;
  (window as unknown as Record<string, unknown>).IntersectionObserver = ctor;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = ctor;
}

// jsdom lacks `Worker`. Provide a minimal stub so the embedding Worker
// (embedding.worker.ts) can initialize without throwing and respond to
// basic messages. Tests that need real Worker behavior should mock the
// embedding module instead.
if (typeof Worker === 'undefined') {
  // Issue #37 R9: arctic-embed-m-v1.5 is 768-dim (was bge-small 384).
  const EMBEDDING_DIMENSIONS = 768;
  class WorkerStub {
    private _onmessage: ((event: MessageEvent) => void) | null = null;
    private _onerror: ((event: ErrorEvent) => void) | null = null;
    set onmessage(handler: ((event: MessageEvent) => void) | null) { this._onmessage = handler; }
    set onerror(handler: ((event: ErrorEvent) => void) | null) { this._onerror = handler; }
    postMessage(msg: unknown): void {
      // Defer reply so the init promise resolves asynchronously.
      const self = this;
      setTimeout(() => {
        if (!self._onmessage) return;
        const data = msg as Record<string, unknown>;
        if (data.kind === 'init') {
          self._onmessage!({ data: { kind: 'ready', dimensions: EMBEDDING_DIMENSIONS } } as MessageEvent);
        } else if (data.kind === 'encode') {
          self._onmessage!({
            data: { kind: 'encode-result', id: data.id, vector: new Float32Array(EMBEDDING_DIMENSIONS) }
          } as MessageEvent);
        } else if (data.kind === 'encodeBatch') {
          const texts = data.texts as string[];
          self._onmessage!({
            data: {
              kind: 'encodeBatch-result',
              id: data.id,
              vectors: texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS))
            }
          } as MessageEvent);
        }
      }, 0);
    }
    terminate(): void { /* no-op */ }
    addEventListener(): void { /* no-op */ }
    removeEventListener(): void { /* no-op */ }
    dispatchEvent(): boolean { return true; }
  }
  (globalThis as unknown as Record<string, unknown>).Worker = WorkerStub;
}
