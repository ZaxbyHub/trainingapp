import { describe, expect, it, vi } from 'vitest';

import { createStoreChannel } from './cross-tab-channel';

/**
 * Frozen check C5 (trace collated-270-273, AC6 of issue #270): a store-change
 * announcement reaches other tabs/instances and never the announcing
 * instance; the channel factory is injected (a pair of in-test linked fakes),
 * so no real BroadcastChannel is needed.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

describe('createStoreChannel', () => {
  function makeLinkedFakes() {
    const instances: FakeChannel[] = [];
    class FakeChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(public name: string) {
        instances.push(this);
      }
      postMessage(message: unknown): void {
        for (const other of instances) {
          if (other === this) continue;
          other.onmessage?.({ data: message } as MessageEvent);
        }
      }
      close(): void {
        /* no-op */
      }
    }
    return { factory: (name: string) => new FakeChannel(name), instances };
  }

  it('delivers a remote change to other instances but not the announcer', () => {
    const { factory } = makeLinkedFakes();
    const a = createStoreChannel('docqa-test-channel', { channelFactory: factory });
    const b = createStoreChannel('docqa-test-channel', { channelFactory: factory });

    const aSeen: number[] = [];
    const bSeen: number[] = [];
    a.onRemoteChange(() => aSeen.push(1));
    b.onRemoteChange(() => bSeen.push(1));

    a.postChange();
    expect(bSeen).toHaveLength(1);
    expect(aSeen).toHaveLength(0);

    b.postChange();
    expect(aSeen).toHaveLength(1);
    expect(bSeen).toHaveLength(1);
  });

  it('two instances in the SAME tab still do not hear themselves (sender-id guard)', () => {
    // BroadcastChannel delivers to same-tab second instances; the sender-id
    // guard is what keeps the announcing instance silent about its own posts.
    const { factory } = makeLinkedFakes();
    const a1 = createStoreChannel('docqa-same-tab', { channelFactory: factory });
    const a2 = createStoreChannel('docqa-same-tab', { channelFactory: factory });

    const a1Seen: number[] = [];
    const a2Seen: number[] = [];
    a1.onRemoteChange(() => a1Seen.push(1));
    a2.onRemoteChange(() => a2Seen.push(1));

    a1.postChange();
    expect(a1Seen).toHaveLength(0);
    expect(a2Seen).toHaveLength(1);
  });

  it('unsubscribe stops delivery', () => {
    const { factory } = makeLinkedFakes();
    const a = createStoreChannel('docqa-unsub', { channelFactory: factory });
    const b = createStoreChannel('docqa-unsub', { channelFactory: factory });
    const seen: number[] = [];
    const unsubscribe = b.onRemoteChange(() => seen.push(1));
    a.postChange();
    expect(seen).toHaveLength(1);
    unsubscribe();
    a.postChange();
    expect(seen).toHaveLength(1);
  });

  it('works when the factory returns null (no channel available)', () => {
    const a = createStoreChannel('docqa-null', { channelFactory: () => null });
    const seen: number[] = [];
    a.onRemoteChange(() => seen.push(1));
    expect(() => a.postChange()).not.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('a closed (throwing) channel does not break postChange', () => {
    const a = createStoreChannel('docqa-closed', {
      channelFactory: () => ({
        postMessage: () => {
          throw new Error('InvalidStateError: channel closed');
        },
        close: () => undefined,
        onmessage: null,
      }),
    });
    expect(() => a.postChange()).not.toThrow();
    void vi;
  });
});
