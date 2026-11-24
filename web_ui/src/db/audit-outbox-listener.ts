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
>> & Pick<DesktopApiBridge, 'onAuditNamespaceRevoked'>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ActiveAuditOutboxContext { generation: number; sender: number; prefix: string }
let activeContext: ActiveAuditOutboxContext | null = null;

/** Clear uses the same live custody identity as delivery; stale tabs cannot cut. */
export function getActiveAuditOutboxContext(): ActiveAuditOutboxContext | null {
  return activeContext === null ? null : { ...activeContext };
}

/** Capture the profile ONCE: a stale tab must never drain as a switched profile. */
export function startAuditOutboxListener(bridge: DesktopApiBridge): () => void {
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

  const queue: OutboxQueue = {
    pending: async () => (await api.getAuditPending(generation, sender)).map((envelope) => ({
      ...envelope,
      event: envelope.event as AuditEventClass,
    })),
    ack: (eventId) => api.ackAuditEvent(eventId, generation, sender),
    currentGeneration: () => generation,
  };

  const drain = async (): Promise<void> => {
    if (draining || stopped || generation === 0) return;
    draining = true;
    try {
      await deliverPendingOutbox(queue, async (envelope: OutboxEnvelope) => {
        await appendAuditEnvelope(envelope, {
          generation,
          sourceSeq: (envelope as OutboxEnvelope & { seq?: number }).seq ?? null,
        });
      }, { generation });
    } catch (error) {
      console.warn('[audit-outbox] delivery deferred:', error instanceof Error ? error.name : String(error));
    } finally {
      draining = false;
    }
  };

  const reconcile = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    try {
      const state = await api.getAuditBindingState();
      if (state.prefix === null) {
        const bound = await api.subscribeAuditOutbox(loadedPrefix, sender);
        generation = bound.generation;
        activeContext = { generation, sender, prefix: loadedPrefix };
      } else if (state.prefix === loadedPrefix) {
        // Same-prefix subscribe is a non-revoking rejoin/add-sender.
        const bound = await api.subscribeAuditOutbox(loadedPrefix, sender);
        generation = bound.generation;
        activeContext = { generation, sender, prefix: loadedPrefix };
      } else {
        // Foreign active binding: stay idle. Never silently rebind.
        generation = 0;
        activeContext = null;
        return;
      }
      await drain();
    } catch (error) {
      if (stopped || attempt >= 3) return;
      await sleep(50 * 2 ** attempt);
      await reconcile(attempt + 1);
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
    void auditDb.close();
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
