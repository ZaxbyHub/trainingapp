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
