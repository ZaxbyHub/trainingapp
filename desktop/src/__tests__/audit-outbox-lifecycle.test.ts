import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendStandalone,
  bindOutboxBinding,
  defaultAuditJournalPath,
  ensureAuditOutboxSchema,
  readOutboxBindingState,
  removeOutboxSender,
  writeAuditJournalFallback,
} from '../../main/backend/audit-outbox';
import { getCurrentStore, openStore } from '../../main/backend/store/sqlite-store';
import { StoreDocumentSurface } from '../../main/backend/store/document-surface';
import { restoreBackup } from '../../main/backend/store/backup';
import { reinitializeStore } from '../../main/backend/store/recovery';

function tempStore(label: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `audit-${label}-`)), 'store.sqlite');
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
      expect(readOutboxBindingState(store).epoch).toBe(1);
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
