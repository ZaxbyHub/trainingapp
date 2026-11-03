/**
 * Frozen check C3 (trace collated-275-268, AC3 of issue #275).
 *
 * One shared named-exclusive-lock helper (`./exclusive-lock`, export
 * `withExclusiveLock(name, work, opts?)`) bounds acquisition on BOTH paths —
 * the Web-Locks acquisition (bounded by an abort signal) and the in-tab
 * promise-chain fallback (same bound, entry cleanup) — with `opts`
 * `{ lockManager?: LockManagerLike | null; acquireTimeoutMs?: number }`
 * (the `withStoreLock` option contract, so the three existing hand-rolled
 * implementations can migrate mechanically).
 *
 * The spec ALSO pins the migration named by the AC: `cross-tab.ts` and
 * `pack-store-opfs.ts` route through the shared helper, and `conv-protocol.ts`
 * either migrates onto it or carries a deliberate-divergence annotation.
 *
 * Today three divergent implementations exist (`withStoreLock` bounded,
 * `withPackLock` unbounded, `withConversationWriteLock` its own fallback), so
 * the helper and this spec are absent at base.
 *
 * RED at base (module absent), GREEN after the fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { withExclusiveLock } from './exclusive-lock';
import type { LockManagerLike } from './exclusive-lock';

describe('withExclusiveLock (shared named exclusive lock, C3)', () => {
  let order: string[];

  beforeEach(() => {
    order = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Web-Locks path (injected LockManager)', () => {
    function makeLockManager(): { manager: LockManagerLike; request: ReturnType<typeof vi.fn> } {
      // Serialize exactly like the real Web Locks API: each request waits
      // for the previous holder's promise to settle before invoking its
      // callback (mirrors cross-tab.test.ts's fake).
      let chain: Promise<unknown> = Promise.resolve();
      const request = vi.fn(
        (
          _name: string,
          _opts: { mode?: 'shared' | 'exclusive'; signal?: AbortSignal },
          callback: (lock: unknown) => Promise<unknown>
        ) => {
          const run = chain.then(() => callback({}));
          chain = run.then(
            () => undefined,
            () => undefined
          );
          return run;
        }
      );
      return { manager: { request }, request };
    }

    it('runs the second critical section only after the first settles', async () => {
      const { manager } = makeLockManager();
      let releaseFirst: (() => void) | null = null;

      const first = withExclusiveLock('docqa-lock-a', async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first:end');
      }, { lockManager: manager });

      const second = withExclusiveLock('docqa-lock-a', async () => {
        order.push('second:start');
      }, { lockManager: manager });

      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      releaseFirst!();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('requests an EXCLUSIVE lock by name', async () => {
      const { manager, request } = makeLockManager();
      await withExclusiveLock('docqa-lock-mode', async () => undefined, {
        lockManager: manager,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe('docqa-lock-mode');
      expect(request.mock.calls[0][1]).toMatchObject({ mode: 'exclusive' });
    });

    it('propagates the work result and rejection through the lock', async () => {
      const { manager } = makeLockManager();
      await expect(
        withExclusiveLock('docqa-lock-pass', async () => 'value', { lockManager: manager })
      ).resolves.toBe('value');
      await expect(
        withExclusiveLock('docqa-lock-pass', async () => {
          throw new Error('boom');
        }, { lockManager: manager })
      ).rejects.toThrow('boom');
    });

    it('bounds acquisition: a lock that is never granted rejects within acquireTimeoutMs', async () => {
      vi.useFakeTimers();
      // A stuck holder: request() parks forever and never invokes the
      // callback - the helper's own acquisition bound must trip.
      const stuckManager: LockManagerLike = {
        request: () => new Promise<never>(() => {}),
      };
      const acquire = withExclusiveLock('docqa-lock-stuck', async () => 'never runs', {
        lockManager: stuckManager,
        acquireTimeoutMs: 50,
      });
      const verdict = expect(acquire).rejects.toThrow(/docqa-lock-stuck/);
      await vi.advanceTimersByTimeAsync(60);
      await verdict;
    });
  });

  describe('in-tab promise-chain fallback (no Web Locks)', () => {
    it('runs the second critical section only after the first settles', async () => {
      let releaseFirst: (() => void) | null = null;
      const first = withExclusiveLock('docqa-fallback-a', async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first:end');
      }, { lockManager: null });
      const second = withExclusiveLock('docqa-fallback-a', async () => {
        order.push('second:start');
      }, { lockManager: null });

      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      releaseFirst!();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('runs the queued section after a rejecting first section', async () => {
      const p1 = withExclusiveLock('docqa-fallback-rej', async () => {
        order.push('first');
        throw new Error('first fails');
      }, { lockManager: null });
      const p2 = withExclusiveLock('docqa-fallback-rej', async () => {
        order.push('second');
      }, { lockManager: null });
      await expect(p1).rejects.toThrow('first fails');
      await p2;
      expect(order).toEqual(['first', 'second']);
    });

    it('bounds the wait for a stuck predecessor and never wedges the name', async () => {
      vi.useFakeTimers();
      let releaseStuck: (() => void) | null = null;
      const stuck = withExclusiveLock('docqa-fallback-stuck', async () => {
        order.push('stuck:start');
        await new Promise<void>((resolve) => {
          releaseStuck = resolve;
        });
        order.push('stuck:end');
      }, { lockManager: null });

      const queued = withExclusiveLock('docqa-fallback-stuck', async () => {
        order.push('queued');
      }, { lockManager: null, acquireTimeoutMs: 50 });
      const verdict = expect(queued).rejects.toThrow(/docqa-fallback-stuck/);
      await vi.advanceTimersByTimeAsync(60);
      await verdict;

      // Entry cleanup: once the stuck predecessor settles (or on a fresh
      // name state), a later caller must still be able to run - the bound
      // must bound, not poison, the lock name.
      releaseStuck!();
      await stuck;
      const third = withExclusiveLock('docqa-fallback-stuck', async () => {
        order.push('third');
      }, { lockManager: null, acquireTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(5);
      await third;
      expect(order).toEqual(['stuck:start', 'stuck:end', 'third']);
    });
  });

  describe('migrated consumers (AC3 migration pin)', () => {
    const sourceOf = (relative: string): string =>
      readFileSync(new URL(relative, import.meta.url), 'utf-8');

    it('cross-tab.ts routes withStoreLock through the shared helper', () => {
      expect(sourceOf('./cross-tab.ts')).toMatch(/exclusive-lock/);
    });

    it('pack-store-opfs.ts routes withPackLock through the shared helper', () => {
      expect(sourceOf('../packs/pack-store-opfs.ts')).toMatch(/exclusive-lock/);
    });

    it('conv-protocol.ts migrates onto the helper or is annotated deliberately divergent', () => {
      const source = sourceOf('../db/conv-protocol.ts');
      const migrated = source.includes('exclusive-lock');
      const annotated = /deliberately divergent/i.test(source);
      expect(migrated || annotated).toBe(true);
    });
  });
});
