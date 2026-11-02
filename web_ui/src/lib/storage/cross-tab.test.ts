import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withStoreLock } from './cross-tab';

/**
 * Frozen check C4 (trace collated-270-273, AC5 of issue #270): a named store
 * lock serializes concurrent critical sections — the second runs only after
 * the first has settled — both with an injected LockManager (Web Locks path)
 * and with none available (in-tab promise-chain fallback). jsdom has no
 * navigator.locks, so the injection is what exercises the Web Locks path.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

describe('withStoreLock', () => {
  let order: string[];

  beforeEach(() => {
    order = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with an injected LockManager', () => {
    function makeLockManager(): {
      manager: { request: ReturnType<typeof vi.fn> };
    } {
      // Serialize exactly like the real Web Locks API: each request waits for
      // the previous holder's promise to settle before invoking its callback.
      let chain: Promise<void> = Promise.resolve();
      const manager = {
        request: vi.fn(
          (
            _name: string,
            _opts: { mode?: 'shared' | 'exclusive' },
            callback: (lock: unknown) => Promise<unknown>
          ) => {
            const run = chain.then(() => callback({}));
            chain = run.then(
              () => undefined,
              () => undefined
            );
            return run;
          }
        ),
      };
      return { manager };
    }

    it('runs the second critical section only after the first settles', async () => {
      const { manager } = makeLockManager();
      let releaseFirst: (() => void) | null = null;

      const first = withStoreLock('docqa-test', async () => {
        order.push('first:start');
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push('first:end');
      }, { lockManager: manager as unknown as LockManager });

      const second = withStoreLock('docqa-test', async () => {
        order.push('second:start');
      }, { lockManager: manager as unknown as LockManager });

      await Promise.resolve();
      await Promise.resolve();
      // First holds the (parked) lock; second must not have started.
      expect(order).toEqual(['first:start']);

      releaseFirst!();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('requests an exclusive lock by name', async () => {
      const { manager } = makeLockManager();
      await withStoreLock('docqa-test', async () => undefined, {
        lockManager: manager as unknown as LockManager,
      });
      expect(manager.request).toHaveBeenCalledWith(
        'docqa-test',
        { mode: 'exclusive' },
        expect.any(Function)
      );
    });

    it('propagates the work result and rejection through the lock', async () => {
      const { manager } = makeLockManager();
      await expect(
        withStoreLock('docqa-test', async () => 'value', { lockManager: manager as unknown as LockManager })
      ).resolves.toBe('value');
      await expect(
        withStoreLock('docqa-test', async () => {
          throw new Error('boom');
        }, { lockManager: manager as unknown as LockManager })
      ).rejects.toThrow('boom');
    });

    it('runs the queued section after a rejecting first section', async () => {
      const { manager } = makeLockManager();
      const p1 = withStoreLock('docqa-test', async () => {
        order.push('first');
        throw new Error('first fails');
      }, { lockManager: manager as unknown as LockManager });
      const p2 = withStoreLock('docqa-test', async () => {
        order.push('second');
      }, { lockManager: manager as unknown as LockManager });
      await expect(p1).rejects.toThrow('first fails');
      await p2;
      expect(order).toEqual(['first', 'second']);
    });
  });

  describe('with no LockManager available (in-tab fallback chain)', () => {
    it('runs the second critical section only after the first settles', async () => {
      let releaseFirst: (() => void) | null = null;
      const first = withStoreLock('docqa-fallback-test', async () => {
        order.push('first:start');
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push('first:end');
      });
      const second = withStoreLock('docqa-fallback-test', async () => {
        order.push('second:start');
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      releaseFirst!();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('chains independently per name', async () => {
      const a = withStoreLock('docqa-chain-a', async () => {
        order.push('a1');
      });
      const b = withStoreLock('docqa-chain-b', async () => {
        order.push('b1');
      });
      await Promise.all([a, b]);
      expect(order).toContain('a1');
      expect(order).toContain('b1');
    });

    it('still rejects the caller when a queued run fails, without blocking later runs', async () => {
      const p1 = withStoreLock('docqa-fallback-err', async () => {
        order.push('first');
        throw new Error('first fails');
      });
      const p2 = withStoreLock('docqa-fallback-err', async () => {
        order.push('second');
      });
      await expect(p1).rejects.toThrow('first fails');
      await p2;
      expect(order).toEqual(['first', 'second']);
    });
  });
});
