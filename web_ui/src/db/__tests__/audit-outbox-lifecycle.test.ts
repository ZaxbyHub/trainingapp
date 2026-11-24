import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import type { DesktopApiBridge } from '../../types/desktop';

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

function bridge(state: { prefix: string | null; generation: number }) {
  const pending: Array<Record<string, unknown>> = [];
  const acked: string[] = [];
  let invalidated: (() => void) | undefined;
  let notified: (() => void) | undefined;
  let revoked: ((payload: { prefix: string }) => void) | undefined;
  const api = {
    getAuditBindingState: vi.fn(async () => ({ ...state, senders: [], epoch: state.generation })),
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
    stops.push(listener.startAuditOutboxListener(channel.api));
    await vi.waitFor(() => expect(channel.acked).toEqual(['same-event']));
    channel.notify();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await audit.listAuditEvents();
    expect(rows.filter((row) => row.eventId === 'same-event')).toHaveLength(1);
    expect(channel.acked).toEqual(['same-event']);
    expect(listener.getActiveAuditOutboxContext()).toMatchObject({ prefix, generation: 3 });
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
});
