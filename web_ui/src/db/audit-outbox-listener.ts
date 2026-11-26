/** Desktop audit-outbox listener: immutable loaded identity + level reconciliation. */
import { getProfilePrefix } from '../lib/storage/profile';
import type { DesktopApiBridge } from '../types/desktop';
import { auditDb, type AuditEventClass } from './audit';
import {
  appendAuditEnvelope,
  deliverPendingOutbox,
  type OutboxEnvelope,
  type OutboxQueue,
} from './audit-outbox';

type AuditBridge = Required<Pick<DesktopApiBridge,
  | 'getAuditBindingState'
  | 'subscribeAuditOutbox'
  | 'getAuditPending'
  | 'ackAuditEvent'
  | 'onAuditPending'
  | 'onAuditBindingInvalidated'
>> & Pick<DesktopApiBridge, 'onAuditNamespaceRevoked' | 'ackAuditNamespaceRevoked'>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The only prefix shape a profile mint can produce (see getProfilePrefix's
 * m1 guard). A persisted lease prefix outside this shape cannot be any tab's
 * loaded identity — it is corruption, not a foreign profile.
 */
const CANONICAL_PREFIX = /^[a-z0-9]{3,8}$/;

export interface ActiveAuditOutboxContext { generation: number; sender: number; prefix: string }
let activeContext: ActiveAuditOutboxContext | null = null;

/**
 * Deterministic test seams. Production never passes hooks; tests use them as
 * completion barriers instead of wall-clock sleeps when asserting that no
 * delayed reconcile/drain action escapes a negative assertion.
 */
export interface AuditListenerHooks {
  onReconcileSettled?: () => void;
  onDrainSettled?: () => void;
}

/** Clear uses the same live custody identity as delivery; stale tabs cannot cut. */
export function getActiveAuditOutboxContext(): ActiveAuditOutboxContext | null {
  return activeContext === null ? null : { ...activeContext };
}

/** Capture the profile ONCE: a stale tab must never drain as a switched profile. */
export function startAuditOutboxListener(bridge: DesktopApiBridge, hooks: AuditListenerHooks = {}): () => void {
  if (bridge.getAuditBindingState === undefined || bridge.subscribeAuditOutbox === undefined ||
      bridge.getAuditPending === undefined || bridge.ackAuditEvent === undefined ||
      bridge.onAuditPending === undefined || bridge.onAuditBindingInvalidated === undefined) {
    return () => {};
  }
  const api = bridge as AuditBridge;
  const loadedPrefix = getProfilePrefix();
  const sender = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  let generation = 0;
  let stopped = false;
  let draining = false;
  let rerun = false;

  const queue: OutboxQueue = {
    pending: async () => (await api.getAuditPending(generation, sender)).map((envelope) => ({
      ...envelope,
      event: envelope.event as AuditEventClass,
    })),
    ack: (eventId) => api.ackAuditEvent(eventId, generation, sender),
    currentGeneration: () => generation,
  };

  const drain = async (): Promise<void> => {
    if (stopped || generation === 0) return;
    // PR #391 F-003: a notification that lands while a drain is in flight must
    // not be dropped. Set a rerun flag and let the active drain take another
    // pass; the single pending() snapshot cannot see events committed after it.
    if (draining) {
      rerun = true;
      return;
    }
    draining = true;
    try {
      do {
        rerun = false;
        const passGeneration = generation;
        await deliverPendingOutbox(queue, async (envelope: OutboxEnvelope) => {
          await appendAuditEnvelope(envelope, {
            generation: passGeneration,
            sourceSeq: (envelope as OutboxEnvelope & { seq?: number }).seq ?? null,
          });
        }, { generation: passGeneration });
      } while (rerun && !stopped && generation !== 0);
    } catch (error) {
      console.warn('[audit-outbox] delivery deferred:', error instanceof Error ? error.name : String(error));
      // A request that arrived while this pass was in flight is still owed a
      // drain even though the pass failed. Re-run once asynchronously; a
      // persistent failure cannot spin because only a new notification sets
      // the flag again.
      if (rerun && !stopped && generation !== 0) {
        rerun = false;
        queueMicrotask(() => { void drain(); });
      }
    } finally {
      draining = false;
      hooks.onDrainSettled?.();
    }
  };

  const reconcile = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    try {
      const state = await api.getAuditBindingState();
      if (stopped) return;
      // A canonical stored prefix that differs from the loaded one is a real
      // foreign active binding: stay idle. Never silently rebind. A
      // NONCANONICAL stored prefix is a malformed persisted lease — no tab can
      // hold it as its identity — so fall through and let the epoch-fenced
      // subscribe below repair the binding with the valid loadedPrefix instead
      // of wedging recovery behind corruption forever.
      if (state.prefix !== null && state.prefix !== loadedPrefix && CANONICAL_PREFIX.test(state.prefix)) {
        generation = 0;
        activeContext = null;
        return;
      }
      // The observed epoch fences a revocation that lands while this subscribe
      // is in flight. A stale attempt is rejected by main and retried from a
      // fresh state read; a stopped listener never publishes context again.
      const bound = await api.subscribeAuditOutbox(loadedPrefix, sender, state.epoch);
      if (stopped) return;
      generation = bound.generation;
      activeContext = { generation, sender, prefix: loadedPrefix };
      await drain();
    } catch (error) {
      if (stopped || attempt >= 3) return;
      await sleep(50 * 2 ** attempt);
      await reconcile(attempt + 1);
    } finally {
      hooks.onReconcileSettled?.();
    }
  };

  const unsubPending = api.onAuditPending(() => { void drain(); });
  const unsubInvalidated = api.onAuditBindingInvalidated(() => { void reconcile(); });
  const stopForNamespace = (revokedPrefix: string): void => {
    if (revokedPrefix !== loadedPrefix) return;
    stopped = true;
    unsubPending();
    unsubInvalidated();
    if (activeContext?.sender === sender) activeContext = null;
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('audit:namespace-revoked', onLocalNamespaceRevoked);
    void Promise.resolve(auditDb.close()).then(() => {
      api.ackAuditNamespaceRevoked?.(revokedPrefix);
    }).catch((error: unknown) => {
      console.warn('[audit-outbox] namespace close failed:', error instanceof Error ? error.name : String(error));
    });
  };
  const onLocalNamespaceRevoked = (event: Event): void => {
    const revokedPrefix = (event as CustomEvent<{ prefix?: unknown }>).detail?.prefix;
    if (typeof revokedPrefix === 'string') stopForNamespace(revokedPrefix);
  };
  window.addEventListener('audit:namespace-revoked', onLocalNamespaceRevoked);
  const unsubNamespace = api.onAuditNamespaceRevoked?.((payload) => {
    const revokedPrefix = (payload as { prefix?: unknown }).prefix;
    if (typeof revokedPrefix === 'string') stopForNamespace(revokedPrefix);
  });
  const onFocus = (): void => { void reconcile(); };
  const onVisibility = (): void => { if (document.visibilityState === 'visible') void reconcile(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  void reconcile();

  return () => {
    stopped = true;
    unsubNamespace?.();
    if (activeContext?.sender === sender) activeContext = null;
    unsubPending();
    unsubInvalidated();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('audit:namespace-revoked', onLocalNamespaceRevoked);
  };
}
