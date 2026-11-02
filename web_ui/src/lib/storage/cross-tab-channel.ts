/**
 * Cross-tab change announcement for the retrieval stores (#270).
 *
 * After a successful store commit the owning module posts a change
 * announcement so other tabs can reload instead of serving stale in-memory
 * state. Merge correctness never depends on delivery: every save re-reads
 * the persisted baseline under the store lock, so a lost message costs only
 * staleness, never data.
 *
 * The posting instance never receives its own message. BroadcastChannel
 * already does not echo to the posting instance, but it DOES deliver to
 * other instances in the same tab (e.g. a second module instance created by
 * `vi.resetModules()` in tests, or two consumers sharing one tab), so each
 * instance stamps messages with a random sender id and ignores its own.
 */

/** Minimal structural type of the BroadcastChannel API surface we use. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface StoreChannel {
  /** Announce a successful store commit to other tabs/instances. */
  postChange(): void;
  /**
   * Subscribe to remote changes. Returns an unsubscribe function. The
   * callback never fires for this instance's own postChange calls.
   */
  onRemoteChange(callback: () => void): () => void;
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createStoreChannel(
  name: string,
  opts?: { channelFactory?: (name: string) => BroadcastChannelLike | null }
): StoreChannel {
  const factory = opts?.channelFactory ?? ((n: string) => {
    const Ctor = (
      globalThis as unknown as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }
    ).BroadcastChannel;
    return Ctor ? new Ctor(n) : null;
  });

  const selfId = randomId();
  const channel = factory(name);
  const listeners = new Set<() => void>();

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data = event?.data as { sender?: string } | null | undefined;
      if (data && typeof data === 'object' && data.sender === selfId) return;
      for (const listener of listeners) listener();
    };
  }

  return {
    postChange() {
      try {
        channel?.postMessage({ sender: selfId });
      } catch {
        // A closed/errored channel must never break the store commit that
        // finished successfully before the announcement.
      }
    },
    onRemoteChange(callback: () => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
