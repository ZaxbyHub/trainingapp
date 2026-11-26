import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import type { DesktopApiBridge, DesktopAuditEnvelope } from '../../types/desktop';

let prefixCounter = 0;
const nextPrefix = (): string => 'al' + String(++prefixCounter).padStart(6, '0');
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.resetModules();
  localStorage.clear();
  delete window.desktopApi;
});

async function load(prefix: string) {
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  const audit = await import('../audit');
  const listener = await import('../audit-outbox-listener');
  return { audit, listener };
}

function bridge(state: { prefix: string | null; generation: number; epoch?: number }) {
  const pending: Array<Record<string, unknown>> = [];
  const acked: string[] = [];
  let invalidated: (() => void) | undefined;
  let notified: (() => void) | undefined;
  let revoked: ((payload: { prefix: string }) => void) | undefined;
  const api = {
    getAuditBindingState: vi.fn(async () => ({ ...state, senders: [], epoch: state.epoch ?? state.generation })),
    subscribeAuditOutbox: vi.fn(async (prefix: string) => {
      state.prefix = prefix;
      return { prefix, generation: state.generation };
    }),
    getAuditPending: vi.fn(async () => pending),
    ackAuditEvent: vi.fn(async (eventId: string) => {
      acked.push(eventId);
      const index = pending.findIndex((row) => row.eventId === eventId);
      if (index >= 0) pending.splice(index, 1);
    }),
    auditBeforeClear: vi.fn(async () => ({ clearSeq: 2, clearGen: 4 })),
    onAuditPending: vi.fn((callback: () => void) => { notified = callback; return () => { notified = undefined; }; }),
    onAuditBindingInvalidated: vi.fn((callback: () => void) => { invalidated = callback; return () => { invalidated = undefined; }; }),
    onAuditNamespaceRevoked: vi.fn((callback: (payload: { prefix: string }) => void) => { revoked = callback; return () => { revoked = undefined; }; }),
  } as unknown as DesktopApiBridge;
  return { api, pending, acked, invalidate: () => invalidated?.(), notify: () => notified?.(), revoke: (prefix: string) => revoked?.({ prefix }) };
}

describe('desktop audit bridge lifecycle', () => {
  // Control for the malformed-lease recovery below: 'foreign0' matches the
  // canonical mint shape ^[a-z0-9]{3,8}$, so it is a real foreign profile and
  // must never be taken over.
  test('a foreign active profile stays idle and never drains', async () => {
    const prefix = nextPrefix();
    const { listener } = await load(prefix);
    const channel = bridge({ prefix: 'foreign0', generation: 9 });
    channel.pending.push({ eventId: 'foreign-event', event: 'app_start', subject: 'p', occurredAt: Date.now(), seq: 1 });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(channel.api.getAuditBindingState).toHaveBeenCalled());
    expect(channel.api.subscribeAuditOutbox).not.toHaveBeenCalled();
    expect(channel.api.getAuditPending).not.toHaveBeenCalled();
    expect(listener.getActiveAuditOutboxContext()).toBeNull();
  });

  test('a malformed persisted lease recovers via the listener subscribe and drains pending delivery', async () => {
    const prefix = nextPrefix();
    const { audit, listener } = await load(prefix);
    // 'AL-0001!' cannot be a minted profile (uppercase/hyphen/bang) and is not
    // the loaded prefix: a malformed persisted lease must not strand the
    // namespace. The real listener path (startAuditOutboxListener) has to
    // rebind with the valid loaded identity and drain the pending outbox.
    const channel = bridge({ prefix: 'AL-0001!', generation: 5, epoch: 11 });
    channel.pending.push({ eventId: 'recover-event', event: 'pack_install', subject: 'pack-b', occurredAt: Date.now(), seq: 4 });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(channel.acked).toEqual(['recover-event']));
    expect(channel.api.subscribeAuditOutbox).toHaveBeenCalledTimes(1);
    expect(channel.api.subscribeAuditOutbox).toHaveBeenCalledWith(prefix, expect.any(Number), 11);
    expect(channel.api.getAuditPending).toHaveBeenCalledWith(5, expect.any(Number));
    const rows = await audit.listAuditEvents();
    expect(rows.filter((row) => row.eventId === 'recover-event')).toHaveLength(1);
    expect(listener.getActiveAuditOutboxContext()).toMatchObject({ prefix, generation: 5 });
  });

  test('revocation during a pending state read prevents stale rebind', async () => {
    const prefix = nextPrefix();
    const { listener } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    let release!: (value: { prefix: string | null; generation: number; senders: number[]; epoch: number }) => void;
    const pendingState = new Promise<{ prefix: string | null; generation: number; senders: number[]; epoch: number }>((resolve) => { release = resolve; });
    channel.api.getAuditBindingState = vi.fn(() => pendingState);
    let releaseSettled!: () => void;
    const reconcileSettled = new Promise<void>((resolve) => { releaseSettled = resolve; });
    let armBarrier = false;
    stops.push(listener.startAuditOutboxListener(channel.api, {
      onReconcileSettled: () => { if (armBarrier) releaseSettled(); },
    }));
    await vi.waitFor(() => expect(channel.api.getAuditBindingState).toHaveBeenCalled());
    channel.revoke(prefix);
    // A completion barrier, not a microtask flush or wall-clock sleep: the
    // released reconcile continuation must have SETTLED before the negative
    // assertion, so a stale subscribe cannot escape it.
    armBarrier = true;
    release({ prefix, generation: 3, senders: [], epoch: 0 });
    await reconcileSettled;
    expect(channel.api.subscribeAuditOutbox).not.toHaveBeenCalled();
    expect(listener.getActiveAuditOutboxContext()).toBeNull();
  });

  test('namespace revocation stops the matching listener and closes its audit database', async () => {
    const prefix = nextPrefix();
    const { audit, listener } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(listener.getActiveAuditOutboxContext()?.prefix).toBe(prefix));
    channel.revoke(prefix);
    expect(listener.getActiveAuditOutboxContext()).toBeNull();
    expect(audit.auditDb.isOpen()).toBe(false);
  });

  test('same-prefix rejoin delivers once and acknowledges after the local commit', async () => {
    const prefix = nextPrefix();
    const { audit, listener } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    channel.pending.push({ eventId: 'same-event', event: 'pack_install', subject: 'pack-a', occurredAt: Date.now(), seq: 7 });
    let releaseDrain!: () => void;
    const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let armBarrier = false;
    stops.push(listener.startAuditOutboxListener(channel.api, {
      onDrainSettled: () => { if (armBarrier) releaseDrain(); },
    }));
    await vi.waitFor(() => expect(channel.acked).toEqual(['same-event']));
    // The notification's drain must COMPLETE before the exactly-once
    // assertion; a delayed duplicate delivery cannot escape the barrier.
    armBarrier = true;
    channel.notify();
    await drained;
    const rows = await audit.listAuditEvents();
    expect(rows.filter((row) => row.eventId === 'same-event')).toHaveLength(1);
    expect(channel.acked).toEqual(['same-event']);
    expect(listener.getActiveAuditOutboxContext()).toMatchObject({ prefix, generation: 3 });
  });

  test('a notification during an in-flight drain re-drains without another trigger', async () => {
    const prefix = nextPrefix();
    const { listener } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    channel.pending.push({ eventId: 'first-event', event: 'pack_install', subject: 'pack-a', occurredAt: Date.now(), seq: 1 });
    const basePending = channel.api.getAuditPending!;
    let pendingCalls = 0;
    let releaseSecond!: (rows: DesktopAuditEnvelope[]) => void;
    channel.api.getAuditPending = vi.fn(async (pendingGeneration: number, pendingSender: number) => {
      pendingCalls += 1;
      if (pendingCalls === 2) {
        return new Promise<DesktopAuditEnvelope[]>((resolve) => { releaseSecond = resolve; });
      }
      return basePending(pendingGeneration, pendingSender);
    });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(channel.acked).toEqual(['first-event']));
    // Second drain hangs on its pending snapshot. A new event arrives and is
    // notified WHILE that drain is active; the stale snapshot cannot contain
    // it, so the listener must rerun on its own.
    channel.notify();
    await vi.waitFor(() => expect(pendingCalls).toBeGreaterThanOrEqual(2));
    channel.pending.push({ eventId: 'second-event', event: 'pack_remove', subject: 'pack-b', occurredAt: Date.now(), seq: 2 });
    channel.notify();
    releaseSecond([]);
    await vi.waitFor(() => expect(channel.acked).toEqual(['first-event', 'second-event']));
    expect(pendingCalls).toBeGreaterThanOrEqual(3);
  });

  test('a notification during a FAILING drain is still re-drained', async () => {
    const prefix = nextPrefix();
    const { listener } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    channel.pending.push({ eventId: 'first-event', event: 'pack_install', subject: 'pack-a', occurredAt: Date.now(), seq: 1 });
    const basePending = channel.api.getAuditPending!;
    let pendingCalls = 0;
    let rejectSecond!: (error: unknown) => void;
    channel.api.getAuditPending = vi.fn((pendingGeneration: number, pendingSender: number) => {
      pendingCalls += 1;
      if (pendingCalls === 2) {
        return new Promise<DesktopAuditEnvelope[]>((_resolve, reject) => { rejectSecond = reject; });
      }
      return basePending(pendingGeneration, pendingSender);
    });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(channel.acked).toEqual(['first-event']));
    channel.notify();
    await vi.waitFor(() => expect(pendingCalls).toBeGreaterThanOrEqual(2));
    channel.pending.push({ eventId: 'second-event', event: 'pack_remove', subject: 'pack-b', occurredAt: Date.now(), seq: 2 });
    channel.notify();
    rejectSecond(new Error('simulated pending failure'));
    // The failed pass must still honor the requested rerun instead of dropping
    // the notification that arrived while it was in flight.
    await vi.waitFor(() => expect(channel.acked).toEqual(['first-event', 'second-event']));
    expect(pendingCalls).toBeGreaterThanOrEqual(3);
  });

  test('desktop clear fences old and legacy rows but preserves newer events', async () => {
    const prefix = nextPrefix();
    const { audit, listener } = await load(prefix);
    const now = Date.now();
    await audit.auditDb.events.bulkAdd([
      { ts: now, event: 'app_start', subject: 'old', eventId: 'old', source_seq: 1, source_gen: 3 },
      { ts: now, event: 'app_stop', subject: 'legacy', eventId: 'legacy', source_seq: null, source_gen: 3 },
      { ts: now, event: 'pack_install', subject: 'new', eventId: 'new', source_seq: 3, source_gen: 3 },
    ]);
    const channel = bridge({ prefix, generation: 3 });
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(listener.getActiveAuditOutboxContext()?.generation).toBe(3));
    window.desktopApi = channel.api;
    await audit.clearAuditLog();
    const rows = await audit.auditDb.events.toArray();
    expect(rows.map((row) => row.event)).toEqual(['pack_install', 'audit_log_cleared']);
    expect(rows[0].eventId).toBe('new');
    expect(channel.api.auditBeforeClear).toHaveBeenCalledWith(3, expect.any(Number));
    expect(await audit.auditDb.meta.get('audit_clear_seq')).toEqual({ key: 'audit_clear_seq', value: 2 });
    expect(await audit.auditDb.meta.get('audit_clear_gen')).toEqual({ key: 'audit_clear_gen', value: 4 });
  });

  test('clear with the desktop bridge but no active custody context fails closed and keeps rows', async () => {
    const prefix = nextPrefix();
    const { audit } = await load(prefix);
    const channel = bridge({ prefix, generation: 3 });
    // Bridge present, listener never started: getActiveAuditOutboxContext()
    // stays null. Pre-fix this fell through to a full local clear without the
    // main fence, so pending main rows could reappear after the clear.
    window.desktopApi = channel.api;
    await audit.auditDb.events.add({ ts: Date.now(), event: 'app_start', subject: 'p', eventId: 'kept', source_seq: 1, source_gen: 3 });
    await expect(audit.clearAuditLog()).rejects.toThrow(/active desktop audit binding/);
    const rows = await audit.auditDb.events.toArray();
    expect(rows.map((row) => row.eventId)).toEqual(['kept']);
    expect(channel.api.auditBeforeClear).not.toHaveBeenCalled();
  });
});
