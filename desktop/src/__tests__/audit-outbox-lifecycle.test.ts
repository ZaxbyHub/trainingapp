import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ackOutboxEvent,
  appendStandalone,
  bindOutboxBinding,
  captureClear,
  consumeAuditJournal,
  defaultAuditJournalPath,
  ensureAuditOutboxSchema,
  readOutboxBindingState,
  removeOutboxSender,
  revokeOutboxNamespace,
  writeAuditJournalFallback,
} from '../../main/backend/audit-outbox';
import { getCurrentStore, openStore } from '../../main/backend/store/sqlite-store';
import { StoreDocumentSurface } from '../../main/backend/store/document-surface';
import { restoreBackup } from '../../main/backend/store/backup';
import { reinitializeStore } from '../../main/backend/store/recovery';

function tempStore(label: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `audit-${label}-`)), 'store.sqlite');
}

/**
 * Wrap a real better-sqlite3 handle so the NEXT `exec('COMMIT')` throws: the
 * pre-COMMIT journal write inside removeOutboxSender/revokeOutboxNamespace
 * reaches the disk file while the database transaction itself is lost — the
 * exact restart-carrier window the reconciliation regressions target.
 */
function failNextCommit(db: Database.Database, control: { armed: boolean }): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string): void => {
          if (sql === 'COMMIT' && control.armed) {
            control.armed = false;
            throw new Error('simulated commit failure');
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function eventIds(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT event_id FROM audit_outbox ORDER BY seq').all() as Array<{ event_id: string }>)
      .map((row) => row.event_id);
  } finally {
    db.close();
  }
}

describe('audit outbox renderer lifetime', () => {
  test('last sender destruction invalidates the binding', async () => {
    const db = new Database(':memory:');
    try {
      ensureAuditOutboxSchema(db);
      const store = { db };
      await bindOutboxBinding(store, 'profile-a', 11);
      expect(removeOutboxSender(store, 11)).toBe(true);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: null, generation: 0, senders: [] });
    } finally {
      db.close();
    }
  });

  test('destroying one of two senders preserves the shared binding', async () => {
    const db = new Database(':memory:');
    try {
      ensureAuditOutboxSchema(db);
      const store = { db };
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      expect(removeOutboxSender(store, 11)).toBe(false);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
      expect(removeOutboxSender(store, 12)).toBe(true);
      // F-003: EVERY committed sender removal (the partial one first, then the
      // final one) advances the epoch, so a restart journal holding a removal
      // the database lost always reconciles by strictly newer epoch.
      expect(readOutboxBindingState(store).epoch).toBe(2);
    } finally {
      db.close();
    }
  });

  test('renderer reload replaces its old sender without revoking another tab', async () => {
    const db = new Database(':memory:');
    try {
      ensureAuditOutboxSchema(db);
      const store = { db };
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      await bindOutboxBinding(store, 'profile-a', 13, 11);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12, 13] });
      expect(removeOutboxSender(store, 13)).toBe(false);
      expect(removeOutboxSender(store, 12)).toBe(true);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: null, senders: [] });
    } finally {
      db.close();
    }
  });

  test('namespace revoke clears only the matching lease and advances custody generations', async () => {
    const db = new Database(':memory:');
    try {
      ensureAuditOutboxSchema(db);
      const store = { db };
      await bindOutboxBinding(store, 'profile-a', 11);
      await expect(bindOutboxBinding(store, 'profile-a', 11, undefined, 0)).resolves.toMatchObject({ generation: 1 });
      const state = revokeOutboxNamespace(store, 'profile-a');
      expect(state).toMatchObject({ prefix: null, senders: [], epoch: 1 });
      await expect(bindOutboxBinding(store, 'profile-a', 11, undefined, 0)).rejects.toThrow('epoch was superseded');
      expect(await bindOutboxBinding(store, 'profile-b', 12, undefined, 1)).toMatchObject({ generation: 3 });
      revokeOutboxNamespace(store, 'profile-a');
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: 'profile-b', senders: [12] });
      expect((await bindOutboxBinding(store, 'profile-c', 13)).generation).toBeGreaterThan(2);
    } finally {
      db.close();
    }
  });

  test('destroyed sender is not resurrected from the restart journal', async () => {
    const dbPath = tempStore('sender-journal');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      expect(removeOutboxSender(store, 11)).toBe(true);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      reopened.close();
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe('audit outbox destructive transitions', () => {
  test('clear cache journals pending events before replacing the database', async () => {
    const dbPath = tempStore('clear');
    const store = openStore({ dbPath, dims: 8 });
    appendStandalone(store, { eventId: 'pending-before-clear', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
    const surface = new StoreDocumentSurface({
      getStore: () => store,
      setStore: () => {},
      embedder: { modelId: 'test' },
      config: {} as never,
    });
    try {
      await surface.clearDocuments();
      const ids = eventIds(dbPath);
      expect(ids).toContain('pending-before-clear');
      expect(ids.some((id) => id !== 'pending-before-clear')).toBe(true);
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('restore merges journal events with a backup even when sequence numbers collide', async () => {
    const activePath = tempStore('restore-active');
    const backupPath = tempStore('restore-backup');
    const active = openStore({ dbPath: activePath, dims: 8 });
    const backup = openStore({ dbPath: backupPath, dims: 8 });
    appendStandalone(active, { eventId: 'active-pending', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
    appendStandalone(backup, { eventId: 'backup-row', event: 'app_start', subject: 'p', occurredAt: Date.now() });
    backup.close();
    active.close();
    try {
      await restoreBackup({ backupPath, dbPath: activePath, dims: 8 });
      openStore({ dbPath: activePath, dims: 8 });
      const ids = eventIds(activePath);
      expect(ids).toEqual(expect.arrayContaining(['active-pending', 'backup-row']));
      expect(ids.filter((id) => id.startsWith('backup-row'))).toHaveLength(1);
      expect(ids.length).toBeGreaterThanOrEqual(3);
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(activePath), { recursive: true, force: true });
      fs.rmSync(path.dirname(backupPath), { recursive: true, force: true });
    }
  });

  test('captureClear re-merges journal high-water before computing the fence', async () => {
    const dbPath = tempStore('clear-journal-high');
    const store = openStore({ dbPath, dims: 8 });
    try {
      fs.writeFileSync(defaultAuditJournalPath(dbPath), JSON.stringify({
        pending: [], fallback: [], clear_seq: 0, clear_at: 0, clear_gen: 0,
        lease: null, seq_high: 11, gen_high: 0, binding_epoch: 0,
      }));
      appendStandalone(store, { eventId: 'old', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      expect(await captureClear(store)).toEqual({ clearSeq: 10, clearGen: 1 });
      const next = appendStandalone(store, { eventId: 'new', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      expect(next.seq).toBe(11);
      expect(eventIds(dbPath)).toEqual(['new']);
    } finally {
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a malformed restart journal on a healthy store is quarantined, not fatal', async () => {
    const dbPath = tempStore('corrupt-journal');
    const journalPath = defaultAuditJournalPath(dbPath);
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      appendStandalone(store, { eventId: 'survivor', event: 'app_start', subject: 'p', occurredAt: Date.now() });
    } finally {
      store.close();
    }
    fs.writeFileSync(journalPath, '{not valid json');
    try {
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        // Healthy SQLite + corrupt sidecar must still open; the pending row is
        // retained and the custody binding is invalidated so a renderer
        // re-subscribes.
        expect(eventIds(dbPath)).toContain('survivor');
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
        const quarantined = fs.readdirSync(path.dirname(journalPath)).filter((name) => name.includes('.corrupt-'));
        expect(quarantined).toHaveLength(1);
        expect(fs.readFileSync(path.join(path.dirname(journalPath), quarantined[0]), 'utf8')).toBe('{not valid json');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a syntax-valid but wrong-shaped journal is quarantined, not fatal', async () => {
    // Each malformed fixture gets its OWN fresh store and journal, and asserts
    // ITS bytes were quarantined. A shared store with a "> 0 corrupt files"
    // assertion could pass later fixtures without quarantining them.
    const fixtures = ['{"pending":null}', '{"pending":[null]}', '[]'];
    for (const [index, malformed] of fixtures.entries()) {
      const dbPath = tempStore(`corrupt-shape-${String(index)}`);
      const journalPath = defaultAuditJournalPath(dbPath);
      const survivor = `shape-survivor-${String(index)}`;
      const seed = openStore({ dbPath, dims: 8 });
      try {
        await bindOutboxBinding(seed, 'profile-a', 11);
        appendStandalone(seed, { eventId: survivor, event: 'app_start', subject: 'p', occurredAt: Date.now() });
      } finally {
        seed.close();
      }
      fs.writeFileSync(journalPath, malformed);
      try {
        const reopened = openStore({ dbPath, dims: 8 });
        try {
          expect(eventIds(dbPath)).toContain(survivor);
          expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
          expect(fs.existsSync(journalPath), 'the malformed journal was moved aside').toBe(false);
          const corrupt = fs.readdirSync(path.dirname(journalPath)).filter((name) => name.includes('.corrupt-'));
          expect(corrupt).toHaveLength(1);
          expect(fs.readFileSync(path.join(path.dirname(journalPath), corrupt[0]), 'utf8')).toBe(malformed);
        } finally {
          reopened.close();
        }
      } finally {
        getCurrentStore()?.close();
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      }
    }
  });

  test('a failed recovery COMMIT leaves the corrupt journal for the next open', async () => {
    const dbPath = tempStore('corrupt-commit-fail');
    const journalPath = defaultAuditJournalPath(dbPath);
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      appendStandalone(store, { eventId: 'kept', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      fs.writeFileSync(journalPath, '{bad');
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      // Quarantine happens only AFTER the recovery COMMIT: a rolled-back
      // invalidation must leave the corrupt journal where the next open can
      // retry it, not hide it behind a rename.
      expect(() => consumeAuditJournal(failing, journalPath)).toThrow('simulated commit failure');
      expect(fs.existsSync(journalPath)).toBe(true);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: 'profile-a', senders: [11] });
    } finally {
      store.close();
    }
    try {
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
        expect(eventIds(dbPath)).toContain('kept');
        expect(fs.existsSync(journalPath)).toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('the ack-tombstone growth warning fires once at the threshold', async () => {
    const dbPath = tempStore('ack-warn');
    const journalPath = defaultAuditJournalPath(dbPath);
    const store = openStore({ dbPath, dims: 8 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = await bindOutboxBinding(store, 'profile-a', 11);
      appendStandalone(store, { eventId: 'warn-target', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      // Seed the journal just below the 5,000-entry threshold so one real ack
      // crosses it; this exercises the ack path, not a helper.
      fs.writeFileSync(journalPath, JSON.stringify({
        pending: [], fallback: [], clear_seq: 0, clear_at: 0, clear_gen: 0, lease: null,
        seq_high: 1, gen_high: 0, binding_epoch: 0, removed_senders: [], revoked: [],
        acked: Array.from({ length: 4999 }, (_, index) => `old-${String(index)}`),
      }));
      expect(await ackOutboxEvent(store, binding.generation, 11, 'warn-target')).toBe(true);
      const growthWarnings = (): number => warn.mock.calls.filter((call) => String(call[0]).includes('ack tombstone journal')).length;
      expect(growthWarnings()).toBe(1);
      appendStandalone(store, { eventId: 'warn-second', event: 'app_stop', subject: 'p', occurredAt: Date.now() });
      expect(await ackOutboxEvent(store, binding.generation, 11, 'warn-second')).toBe(true);
      expect(growthWarnings(), 'the warning is once per process, not per ack').toBe(1);
    } finally {
      warn.mockRestore();
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('fresh recovery records the destructive transition before reopening', async () => {
    const dbPath = tempStore('fresh');
    fs.writeFileSync(dbPath, 'not a sqlite database');
    try {
      const store = await reinitializeStore({ dbPath, dims: 8 });
      store.close();
      const ids = eventIds(dbPath);
      expect(ids).toHaveLength(1);
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe('audit outbox restart reconciliation (F-002/F-003)', () => {
  test('an acked event stays acked across reopen while an unacknowledged control survives', async () => {
    const dbPath = tempStore('ack-replay');
    const store = openStore({ dbPath, dims: 8 });
    try {
      appendStandalone(store, { eventId: 'ack-target', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
      appendStandalone(store, { eventId: 'ack-control', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      // The destructive-transition journal snapshots BOTH pending rows.
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'ack-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      store.close();
      const consumed = openStore({ dbPath, dims: 8 });
      consumed.close();
      // Consume inserted the journal snapshot; an authorized sender acks ONE
      // event (ack-after-delivery). The unacknowledged control is never acked.
      const live = openStore({ dbPath, dims: 8 });
      const binding = await bindOutboxBinding(live, 'profile-a', 11);
      expect(await ackOutboxEvent(live, binding.generation, 11, 'ack-target')).toBe(true);
      live.close();
      // Reopen replays the journal: the acked event must NOT resurrect from
      // the pending/fallback snapshot; the control must still be pending.
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        const ids = eventIds(dbPath);
        expect(ids).not.toContain('ack-target');
        expect(ids).toContain('ack-control');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('final sender removal whose COMMIT fails still reconciles on reopen', async () => {
    const dbPath = tempStore('remove-final-fail');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // The journal recorded the invalidation before the failed COMMIT; the
      // database rolled back to the destroyed sender's lease. Reopen must let
      // the removal win, not resurrect the destroyed renderer's binding.
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
        expect(readOutboxBindingState(reopened).epoch).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('partial sender removal whose COMMIT fails still reconciles on reopen', async () => {
    const dbPath = tempStore('remove-partial-fail');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // The surviving sender must keep the binding WITHOUT the destroyed
      // sender: the equal-generation removal the journal witnessed wins over
      // the database's rolled-back sender set.
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
        expect(readOutboxBindingState(reopened).epoch).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('namespace revocation whose COMMIT fails still reconciles on reopen', async () => {
    const dbPath = tempStore('revoke-fail');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => revokeOutboxNamespace(failing, 'profile-a')).toThrow('simulated commit failure');
      // The revoked namespace must not come back from the rolled-back
      // database state when the journal already carries the revocation.
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
        expect(readOutboxBindingState(reopened).epoch).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a journaled removal cannot erase a newer rebind after a failed COMMIT', async () => {
    const dbPath = tempStore('remove-stale-guard');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // A NEWER valid lease forms after the failed removal, above the
      // journal's gen_high knowledge. The stale removal journal must not
      // erase it on reopen.
      const rebound = await bindOutboxBinding(store, 'profile-b', 22);
      expect(rebound.generation).toBeGreaterThan(1);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-b', senders: [22] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a stale partial snapshot cannot drop a sender added after it', async () => {
    const dbPath = tempStore('partial-stale-guard');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 12);
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'stale-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      // Sender 11 binds AFTER the snapshot: a same-generation journal with a
      // NON-newer epoch is stale and must not shrink the live sender set.
      await bindOutboxBinding(store, 'profile-a', 11);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12, 11] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a sender bound after a failed PARTIAL removal survives the restart reconciliation', async () => {
    const dbPath = tempStore('partial-later-sender');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // A NEW sender binds the SAME prefix/generation after the failed
      // removal. Replay must remove exactly the destroyed sender 11; sender 12
      // AND the later sender 13 survive — a post-state snapshot replace would
      // drop 13.
      await bindOutboxBinding(store, 'profile-a', 13);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12, 13] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a sender bound after a failed FINAL removal survives the restart reconciliation', async () => {
    const dbPath = tempStore('final-later-sender');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // The database rolled back to sender 11's solo lease; a NEW sender then
      // binds the SAME prefix (same generation — no gen_high advance, so the
      // newer-generation guard alone cannot protect it). Replay must remove
      // exactly sender 11 and keep the binding alive for the later sender 12 —
      // a whole-binding null-delete would erase it.
      await bindOutboxBinding(store, 'profile-a', 12);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('an outstanding sender delta reconciles even after a later removal commits at the same epoch', async () => {
    const dbPath = tempStore('same-epoch-delta');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      // Removal of 11 journals its delta, then fails its COMMIT: the database
      // rolls back to [11, 12] and its committed epoch stays at 0.
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // Removal of 12 then COMMITS, computing the SAME next epoch from the
      // rolled-back base — the journal's binding_epoch no longer exceeds the
      // database's. The committed sender set is [11] (12 removed, 11's failed
      // removal still unapplied), so the binding stays partial.
      expect(removeOutboxSender(store, 12)).toBe(false);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        // The outstanding delta for the destroyed sender 11 must still
        // reconcile — an epoch-equality gate alone would skip it and leak 11
        // into the binding forever.
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
        expect(readOutboxBindingState(reopened).epoch).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a revoke of a different prefix preserves the outstanding sender delta', async () => {
    const dbPath = tempStore('revoke-other-prefix');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      // Removal of 11 journals its scoped delta, then fails its COMMIT.
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // Revoking an UNRELATED namespace commits; the profile-a binding it
      // does not match survives the revocation untouched.
      expect(revokeOutboxNamespace(store, 'profile-b')).toMatchObject({ prefix: 'profile-a', senders: [11, 12] });
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        // The outstanding profile-a delta must survive the profile-b
        // revocation: replay still removes the destroyed sender 11 and keeps
        // the surviving sender 12 — a blanket delta wipe on revoke would leak
        // sender 11 into the binding forever.
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('an ack tombstone keeps acked events absent when pre-ack database bytes are restored', async () => {
    const dbPath = tempStore('ack-tombstone');
    const preAckCopy = `${dbPath}.pre-ack`;
    const store = openStore({ dbPath, dims: 8 });
    try {
      appendStandalone(store, { eventId: 'tomb-ack', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
      appendStandalone(store, { eventId: 'tomb-control', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'tomb-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      store.close();
      const consumed = openStore({ dbPath, dims: 8 });
      consumed.close();
      // Copy the PRE-ACK database bytes aside (closed handle → WAL
      // checkpointed into the copied file).
      fs.copyFileSync(dbPath, preAckCopy);
      const live = openStore({ dbPath, dims: 8 });
      const binding = await bindOutboxBinding(live, 'profile-a', 11);
      expect(await ackOutboxEvent(live, binding.generation, 11, 'tomb-ack')).toBe(true);
      live.close();
      // Restore the pre-ack bytes: the acked row is PHYSICALLY back in the
      // database, outside the journal's pending/fallback snapshots. Only a
      // durable ack tombstone in the journal can keep it absent.
      fs.copyFileSync(preAckCopy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        const ids = eventIds(dbPath);
        expect(ids).not.toContain('tomb-ack');
        expect(ids).toContain('tomb-control');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a valid ack whose cleanup COMMIT fails still tombstones the event (no redelivery)', async () => {
    const dbPath = tempStore('ack-commit-fail');
    const store = openStore({ dbPath, dims: 8 });
    try {
      appendStandalone(store, { eventId: 'ack-fail-target', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
      appendStandalone(store, { eventId: 'ack-fail-control', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'ack-fail-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      store.close();
      const live = openStore({ dbPath, dims: 8 });
      const binding = await bindOutboxBinding(live, 'profile-a', 11);
      // Renderer-commit contract: the renderer acks only AFTER its own
      // IndexedDB delivery commit, so this AUTHORIZED ack is itself the
      // delivery commit point — the main-process DELETE is cleanup. Its
      // COMMIT fails (the row survives the rollback and the error surfaces),
      // but reopen must NOT redeliver an event the renderer already
      // committed: the tombstone written before the cleanup stands.
      const failing = { db: failNextCommit(live.db, { armed: true }), dbPath };
      await expect(ackOutboxEvent(failing, binding.generation, 11, 'ack-fail-target')).rejects.toThrow('simulated commit failure');
      live.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        const ids = eventIds(dbPath);
        expect(ids).not.toContain('ack-fail-target');
        expect(ids).toContain('ack-fail-control');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('an unauthorized repeat ack cannot withdraw a committed tombstone', async () => {
    const dbPath = tempStore('ack-unauthorized-repeat');
    const preAckCopy = `${dbPath}.pre-ack`;
    const store = openStore({ dbPath, dims: 8 });
    try {
      appendStandalone(store, { eventId: 'repeat-target', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
      appendStandalone(store, { eventId: 'repeat-control', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'repeat-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      store.close();
      const consumed = openStore({ dbPath, dims: 8 });
      consumed.close();
      fs.copyFileSync(dbPath, preAckCopy);
      const live = openStore({ dbPath, dims: 8 });
      const binding = await bindOutboxBinding(live, 'profile-a', 11);
      // The valid, authorized ack commits the tombstone.
      expect(await ackOutboxEvent(live, binding.generation, 11, 'repeat-target')).toBe(true);
      // A stale/unauthorized REPEAT (foreign sender) is rejected by the
      // authorization gate — it must never withdraw the existing tombstone.
      await expect(ackOutboxEvent(live, binding.generation, 99, 'repeat-target')).rejects.toThrow(/rejected|generation|sender/i);
      live.close();
      // Restore the pre-ack bytes: the acked row is physically back. The
      // committed tombstone must still suppress it.
      fs.copyFileSync(preAckCopy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        const ids = eventIds(dbPath);
        expect(ids).not.toContain('repeat-target');
        expect(ids).toContain('repeat-control');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('committed sender-removal deltas replay against restored pre-removal bytes', async () => {
    const dbPath = tempStore('delta-restore-replay');
    const preRemovalCopy = `${dbPath}.pre-removal`;
    let store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      store.close();
      // Pre-removal bytes aside (closed handle → WAL checkpointed).
      fs.copyFileSync(dbPath, preRemovalCopy);
      store = openStore({ dbPath, dims: 8 });
      // The removal COMMITS: its scoped delta stays in the journal so
      // restored same-generation pre-removal bytes replay the removal.
      expect(removeOutboxSender(store, 11)).toBe(false);
      store.close();
      // Restore the pre-removal bytes: the binding physically carries BOTH
      // senders again.
      fs.copyFileSync(preRemovalCopy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('an ack tombstone written before COMMIT survives a lost post-commit window', async () => {
    const dbPath = tempStore('ack-postcommit-lost');
    const preAckCopy = `${dbPath}.pre-ack`;
    const journalPath = defaultAuditJournalPath(dbPath);
    const store = openStore({ dbPath, dims: 8 });
    try {
      appendStandalone(store, { eventId: 'lost-ack', event: 'pack_install', subject: 'p', occurredAt: Date.now() });
      appendStandalone(store, { eventId: 'lost-control', event: 'app_start', subject: 'p', occurredAt: Date.now() });
      await writeAuditJournalFallback(store, journalPath, {
        eventId: 'lost-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      store.close();
      const consumed = openStore({ dbPath, dims: 8 });
      consumed.close();
      fs.copyFileSync(dbPath, preAckCopy);
      const live = openStore({ dbPath, dims: 8 });
      const binding = await bindOutboxBinding(live, 'profile-a', 11);
      // Simulate the process dying RIGHT AFTER COMMIT: the COMMIT itself
      // succeeds, then everything after it is lost — the journal is made
      // unwritable so any post-commit journal write would fail. Suppression
      // of restored pre-ack bytes must rest entirely on the marker written
      // BEFORE COMMIT.
      const control = { armed: true };
      const afterCommitDead = {
        db: new Proxy(live.db, {
          get(target, prop) {
            if (prop === 'exec') {
              return (sql: string): void => {
                target.exec(sql);
                if (sql === 'COMMIT' && control.armed) {
                  control.armed = false;
                  fs.chmodSync(journalPath, 0o444);
                }
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }),
        dbPath,
      };
      expect(await ackOutboxEvent(afterCommitDead, binding.generation, 11, 'lost-ack')).toBe(true);
      live.close();
      // Restore the pre-ack bytes: the acked row is physically back.
      fs.copyFileSync(preAckCopy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.chmodSync(journalPath, 0o666);
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        const ids = eventIds(dbPath);
        expect(ids).not.toContain('lost-ack');
        expect(ids).toContain('lost-control');
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('sender deltas apply to a lease installed into a restored empty binding', async () => {
    const dbPath = tempStore('install-delta');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      // Removal of 11 journals its scoped delta, then fails its COMMIT: the
      // database rolls back with BOTH senders in the binding.
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => removeOutboxSender(failing, 11)).toThrow('simulated commit failure');
      // The destructive-transition snapshot captures the ROLLED-BACK live
      // lease (still containing the destroyed sender 11) while the scoped
      // delta for sender 11 survives in the journal.
      await writeAuditJournalFallback(store, defaultAuditJournalPath(dbPath), {
        eventId: 'install-delta-transition', event: 'clear_cache', subject: 'documents', occurredAt: Date.now(),
      });
      // Simulate a restored/empty binding carrier: the database loses the
      // binding row entirely, so reopen must install the journal lease.
      const raw = new Database(dbPath);
      try {
        raw.prepare('DELETE FROM audit_outbox_binding').run();
      } finally {
        raw.close();
      }
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        // The installed lease is the EFFECTIVE lease: the scoped delta must
        // strip the destroyed sender 11 from it, leaving the survivor 12 —
        // not resurrect sender 11 inside the installed lease.
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-a', generation: 1, senders: [12] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a revocation survives a later committed removal overwriting the journal lease', async () => {
    const dbPath = tempStore('revoke-lease-overwrite');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      await bindOutboxBinding(store, 'profile-a', 12);
      // The revoke journals (nulling the lease), then fails its COMMIT: the
      // database rolls back with the profile-a binding intact.
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => revokeOutboxNamespace(failing, 'profile-a')).toThrow('simulated commit failure');
      // A later PARTIAL sender removal COMMITS; its pre-commit journal write
      // OVERWRITES the nulled lease with the surviving post-removal state —
      // the revocation intent must not depend on the lease staying null.
      expect(removeOutboxSender(store, 11)).toBe(false);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a revocation entry cannot erase a newer-generation rebind', async () => {
    const dbPath = tempStore('revoke-rebind-guard');
    const store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      const failing = { db: failNextCommit(store.db, { armed: true }), dbPath };
      expect(() => revokeOutboxNamespace(failing, 'profile-a')).toThrow('simulated commit failure');
      // A newer-generation rebind forms after the failed revocation.
      const rebound = await bindOutboxBinding(store, 'profile-b', 22);
      expect(rebound.generation).toBeGreaterThan(1);
      store.close();
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: 'profile-b', senders: [22] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('sender-removal deltas dedup by their full scope, not the sender id alone', async () => {
    const dbPath = tempStore('delta-full-scope');
    const gen1Copy = `${dbPath}.gen1`;
    const gen2Copy = `${dbPath}.gen2`;
    let store = openStore({ dbPath, dims: 8 });
    try {
      const first = await bindOutboxBinding(store, 'profile-a', 11);
      store.close();
      fs.copyFileSync(dbPath, gen1Copy);
      store = openStore({ dbPath, dims: 8 });
      expect(removeOutboxSender(store, 11)).toBe(true);
      // The SAME sender id returns in a LATER generation of the same prefix.
      const second = await bindOutboxBinding(store, 'profile-a', 11);
      expect(second.generation).toBeGreaterThan(first.generation);
      store.close();
      fs.copyFileSync(dbPath, gen2Copy);
      store = openStore({ dbPath, dims: 8 });
      expect(removeOutboxSender(store, 11)).toBe(true);
      store.close();
      // Restore the GEN-2 pre-removal bytes: the later-generation delta must
      // exist and replay (sender-id-only dedup would have skipped it).
      fs.copyFileSync(gen2Copy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      let reopened = openStore({ dbPath, dims: 8 });
      expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      reopened.close();
      // Restore the GEN-1 pre-removal bytes: the earlier-generation delta
      // must STILL exist and replay too — both deltas persist independently.
      fs.copyFileSync(gen1Copy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a revoke preserves older-generation removal evidence for restored older bytes', async () => {
    const dbPath = tempStore('revoke-older-gen');
    const gen1Copy = `${dbPath}.gen1`;
    let store = openStore({ dbPath, dims: 8 });
    try {
      const first = await bindOutboxBinding(store, 'profile-a', 11);
      store.close();
      fs.copyFileSync(dbPath, gen1Copy);
      store = openStore({ dbPath, dims: 8 });
      expect(removeOutboxSender(store, 11)).toBe(true);
      // A NEWER generation of the same prefix forms (different sender).
      const rebound = await bindOutboxBinding(store, 'profile-a', 12);
      expect(rebound.generation).toBe(first.generation + 1);
      // Revoking the namespace invalidates the CURRENT (gen-2) generation.
      expect(revokeOutboxNamespace(store, 'profile-a')).toMatchObject({ prefix: null, senders: [] });
      store.close();
      // Restore the GEN-1 pre-removal bytes: the revocation of the newer
      // generation must NOT have wiped the older generation's removal
      // evidence — sender 11 stays removed when those bytes replay.
      fs.copyFileSync(gen1Copy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('renderer reload retirement survives restored pre-reload bytes', async () => {
    const dbPath = tempStore('reload-retire-restore');
    const preReloadCopy = `${dbPath}.pre-reload`;
    let store = openStore({ dbPath, dims: 8 });
    try {
      await bindOutboxBinding(store, 'profile-a', 11);
      store.close();
      fs.copyFileSync(dbPath, preReloadCopy);

      store = openStore({ dbPath, dims: 8 });
      const replacement = await bindOutboxBinding(store, 'profile-a', 12, 11);
      expect(replacement.generation).toBe(1);
      expect(readOutboxBindingState(store)).toMatchObject({ prefix: 'profile-a', senders: [12] });
      expect(removeOutboxSender(store, 12)).toBe(true);
      store.close();

      // Restore bytes from BEFORE the reload replacement. Both the retired
      // sender 11 and destroyed replacement 12 must stay removed on reopen.
      fs.copyFileSync(preReloadCopy, dbPath);
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      const reopened = openStore({ dbPath, dims: 8 });
      try {
        expect(readOutboxBindingState(reopened)).toMatchObject({ prefix: null, senders: [] });
      } finally {
        reopened.close();
      }
    } finally {
      getCurrentStore()?.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
