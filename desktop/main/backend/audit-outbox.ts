// Durable desktop governance outbox (#373). Additive tables only: the
// authoritative store schema_version and migration ladder are unchanged.
import fs from 'node:fs';
import path from 'node:path';

export interface DesktopAuditEnvelope {
  eventId: string;
  event: 'app_start' | 'app_stop' | 'pack_install' | 'pack_remove' | 'settings_change' | 'clear_cache';
  subject: string;
  occurredAt: number;
}

export interface OutboxRow {
  event_id: string;
  seq: number;
  event: string;
  subject: string;
  occurred_at: number;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  readonly inTransaction: boolean;
}

interface StoreLike { db: SqliteDb; dbPath?: string }
export type AuditStoreLike = StoreLike;

export interface CustodyBatch {
  capture(envelope: DesktopAuditEnvelope): void;
  flush(): void | Promise<void>;
  discard(): void;
}

export interface CustodyProvider { beginRequest(): CustodyBatch }

type Notify = (payload: { generation: number; pendingCount: number }) => void;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  event TEXT NOT NULL,
  subject TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seq_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_outbox_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  prefix TEXT NOT NULL,
  generation INTEGER NOT NULL,
  senders TEXT NOT NULL
);
INSERT OR IGNORE INTO seq_meta(key, value) VALUES ('next_seq', 1);
INSERT OR IGNORE INTO seq_meta(key, value) VALUES ('clear_seq', 0);
INSERT OR IGNORE INTO seq_meta(key, value) VALUES ('clear_gen', 0);
INSERT OR IGNORE INTO seq_meta(key, value) VALUES ('binding_epoch', 0);
`;

/** Called on every store open, before any clear/flush/consume can execute. */
export function ensureAuditOutboxSchema(db: SqliteDb): void {
  db.exec(SCHEMA);
}

export function defaultAuditJournalPath(dbPath: string): string {
  return `${dbPath}.audit-journal.json`;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function meta(db: SqliteDb, key: string): number {
  const row = db.prepare('SELECT value FROM seq_meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
  return num(row?.value);
}

function setMeta(db: SqliteDb, key: string, value: number): void {
  db.prepare('INSERT INTO seq_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function maxMeta(db: SqliteDb, key: string, value: number): void {
  setMeta(db, key, Math.max(meta(db, key), value));
}

/** Allocate and append inside the CALLER's transaction. */
export function appendInTx(db: SqliteDb, envelope: DesktopAuditEnvelope): OutboxRow {
  ensureAuditOutboxSchema(db);
  const exists = db.prepare('SELECT 1 FROM audit_outbox WHERE event_id = ?').get(envelope.eventId);
  if (exists !== undefined) {
    const row = db.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox WHERE event_id = ?').get(envelope.eventId) as OutboxRow;
    return row;
  }
  const seq = meta(db, 'next_seq');
  db.prepare('INSERT INTO audit_outbox(event_id, seq, event, subject, occurred_at) VALUES (?, ?, ?, ?, ?)')
    .run(envelope.eventId, seq, envelope.event, envelope.subject, envelope.occurredAt);
  setMeta(db, 'next_seq', seq + 1);
  return { event_id: envelope.eventId, seq, event: envelope.event, subject: envelope.subject, occurred_at: envelope.occurredAt };
}

/** Standalone append owns one immediate transaction. */
export function appendStandalone(store: StoreLike, envelope: DesktopAuditEnvelope): OutboxRow {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const row = appendInTx(store.db, envelope);
    store.db.exec('COMMIT');
    return row;
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

function readLease(db: SqliteDb): { prefix: string; generation: number; senders: number[] } | null {
  const row = db.prepare('SELECT prefix, generation, senders FROM audit_outbox_binding WHERE singleton = 1').get() as
    | { prefix: string; generation: number; senders: string } | undefined;
  if (row === undefined) return null;
  let senders: number[] = [];
  try { senders = JSON.parse(row.senders) as number[]; } catch { senders = []; }
  return { prefix: row.prefix, generation: row.generation, senders };
}

export async function bindOutboxBinding(
  store: StoreLike,
  prefix: string,
  sender: number = 0,
  previousSender?: number,
): Promise<{ prefix: string; generation: number }> {
  const db = store.db;
  ensureAuditOutboxSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readLease(db);
    if (current !== null && current.prefix === prefix) {
      // A renderer reload keeps the same webContents id but creates a new
      // sender. Replace the prior identity atomically so it cannot leak in the
      // sender set and prevent last-window invalidation forever.
      const senders = current.senders.filter((value) => value !== previousSender);
      if (!senders.includes(sender)) senders.push(sender);
      if (senders.length !== current.senders.length || senders.some((value, index) => value !== current.senders[index])) {
        db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1')
          .run(JSON.stringify(senders));
      }
      db.exec('COMMIT');
      return { prefix, generation: current.generation };
    }
    const generation = meta(db, 'gen_high') + 1;
    setMeta(db, 'gen_high', generation);
    db.prepare(`INSERT INTO audit_outbox_binding(singleton, prefix, generation, senders) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET prefix=excluded.prefix, generation=excluded.generation, senders=excluded.senders`)
      .run(prefix, generation, JSON.stringify(sender === 0 ? [] : [sender]));
    db.exec('COMMIT');
    return { prefix, generation };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

export function readOutboxBindingState(store: StoreLike): { prefix: string | null; generation: number; senders: number[]; epoch: number } {
  const current = readLease(store.db);
  return {
    prefix: current?.prefix ?? null,
    generation: current?.generation ?? 0,
    senders: current?.senders ?? [],
    epoch: meta(store.db, 'binding_epoch'),
  };
}

/** Remove a destroyed renderer; empty sender sets invalidate the binding. */
export function removeOutboxSender(store: StoreLike, sender: number): boolean {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readLease(db);
    if (current === null || !current.senders.includes(sender)) {
      db.exec('COMMIT');
      return false;
    }
    const senders = current.senders.filter((value) => value !== sender);
    const nextBinding = senders.length === 0 ? null : { ...current, senders };
    const nextEpoch = senders.length === 0 ? meta(db, 'binding_epoch') + 1 : meta(db, 'binding_epoch');
    // The journal is a restart carrier. Update it before COMMIT so a destroyed
    // sender cannot be resurrected from an older snapshot on the next launch.
    if (store.dbPath !== undefined) {
      const journal = readJournal(defaultAuditJournalPath(store.dbPath));
      journal.lease = nextBinding;
      journal.binding_epoch = Math.max(journal.binding_epoch, nextEpoch);
      writeJournal(defaultAuditJournalPath(store.dbPath), journal);
    }
    if (senders.length === 0) {
      db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
      setMeta(db, 'binding_epoch', nextEpoch);
      db.exec('COMMIT');
      return true;
    }
    db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1').run(JSON.stringify(senders));
    db.exec('COMMIT');
    return false;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

function assertAuthorized(db: SqliteDb, generation: number, sender: number): void {
  const current = readLease(db);
  if (current === null || current.generation !== generation || !current.senders.includes(sender)) {
    throw new Error(`audit outbox binding rejected generation=${String(generation)} sender=${String(sender)}`);
  }
}

export async function readOutboxPending(store: StoreLike, generation: number, sender: number): Promise<OutboxRow[]> {
  assertAuthorized(store.db, generation, sender);
  return store.db.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox ORDER BY seq').all() as OutboxRow[];
}

export async function ackOutboxEvent(store: StoreLike, generation: number, sender: number, eventId: string): Promise<boolean> {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    assertAuthorized(db, generation, sender);
    const result = db.prepare('DELETE FROM audit_outbox WHERE event_id = ?').run(eventId);
    db.exec('COMMIT');
    return Number(result.changes) > 0;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

/** One transaction: bump clear generation, fence allocated seq, delete pending. */
export async function captureClear(store: StoreLike): Promise<{ clearSeq: number; clearGen: number }> {
  const db = store.db;
  ensureAuditOutboxSchema(db);
  const journalPath = store.dbPath === undefined ? null : defaultAuditJournalPath(store.dbPath);
  const journal = journalPath !== null && fs.existsSync(journalPath) ? readJournal(journalPath) : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (journal !== null) {
      maxMeta(db, 'clear_seq', journal.clear_seq);
      maxMeta(db, 'clear_gen', journal.clear_gen);
      maxMeta(db, 'gen_high', journal.gen_high);
      maxMeta(db, 'binding_epoch', journal.binding_epoch);
      const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM audit_outbox').get() as { value: number };
      setMeta(db, 'next_seq', Math.max(meta(db, 'next_seq'), journal.seq_high, num(maxRow.value) + 1));
    }
    const clearGen = meta(db, 'clear_gen') + 1;
    const clearSeq = meta(db, 'next_seq') - 1;
    setMeta(db, 'clear_gen', clearGen);
    setMeta(db, 'clear_seq', clearSeq);
    discardBeforeSeq(store, clearSeq);
    db.exec('COMMIT');
    return { clearSeq, clearGen };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

export function discardBeforeSeq(store: StoreLike, clearSeq: number): void {
  store.db.prepare('DELETE FROM audit_outbox WHERE seq <= ?').run(clearSeq);
}

interface Journal {
  pending: Array<{ envelope: DesktopAuditEnvelope; seq: number }>;
  fallback: Array<{ envelope: DesktopAuditEnvelope; gen: number }>;
  clear_seq: number;
  clear_at: number;
  clear_gen: number;
  lease: { prefix: string; generation: number; senders: number[] } | null;
  seq_high: number;
  gen_high: number;
  binding_epoch: number;
}

function emptyJournal(): Journal {
  return { pending: [], fallback: [], clear_seq: 0, clear_at: 0, clear_gen: 0, lease: null, seq_high: 1, gen_high: 0, binding_epoch: 0 };
}

function readJournal(journalPath: string): Journal {
  if (!fs.existsSync(journalPath)) return emptyJournal();
  return { ...emptyJournal(), ...(JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<Journal>) };
}

function writeJournal(journalPath: string, journal: Journal): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.${String(process.pid)}.${String(Math.random()).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal), 'utf8');
  fs.renameSync(tmp, journalPath);
}

/** Snapshot watermarks + pending rows, then append a capture-time fallback. */
export async function writeAuditJournalFallback(
  store: StoreLike,
  journalPath: string,
  envelope: DesktopAuditEnvelope,
): Promise<void> {
  const db = store.db;
  const journal = readJournal(journalPath);
  journal.pending = db.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox ORDER BY seq').all().map((row) => {
    const r = row as OutboxRow;
    return { seq: r.seq, envelope: { eventId: r.event_id, event: r.event as DesktopAuditEnvelope['event'], subject: r.subject, occurredAt: r.occurred_at } };
  });
  journal.clear_seq = Math.max(journal.clear_seq, meta(db, 'clear_seq'));
  journal.clear_at = Date.now();
  journal.clear_gen = Math.max(journal.clear_gen, meta(db, 'clear_gen'));
  journal.lease = readLease(db);
  journal.seq_high = Math.max(journal.seq_high, meta(db, 'next_seq'));
  journal.gen_high = Math.max(journal.gen_high, meta(db, 'gen_high'));
  journal.binding_epoch = Math.max(journal.binding_epoch, meta(db, 'binding_epoch'));
  journal.fallback.push({ envelope, gen: meta(db, 'clear_gen') });
  writeJournal(journalPath, journal);
}

/**
 * Last-resort destructive-transition record when the active database cannot be
 * opened (for example corruption recovery). Preserve the existing journal and
 * append one fallback; never replace its pending snapshot with an empty one.
 */
export async function writeAuditTransitionFallback(
  journalPath: string,
  envelope: DesktopAuditEnvelope,
): Promise<void> {
  const journal = readJournal(journalPath);
  journal.clear_at = Date.now();
  journal.fallback.push({ envelope, gen: journal.clear_gen });
  writeJournal(journalPath, journal);
}

/** Journal a destructive transition from the live store, or preserve an existing journal. */
export async function journalDestructiveTransition(
  store: StoreLike | null,
  dbPath: string,
  envelope: DesktopAuditEnvelope,
): Promise<void> {
  const journalPath = defaultAuditJournalPath(dbPath);
  if (store !== null && path.resolve(store.dbPath ?? dbPath) === path.resolve(dbPath)) {
    await writeAuditJournalFallback(store, journalPath, envelope);
  } else {
    await writeAuditTransitionFallback(journalPath, envelope);
  }
}

/** Max-merge watermarks, seed sequence floor, gate/insert survivors, remove journal. */
export function consumeAuditJournal(store: StoreLike, journalPath: string): void {
  if (!fs.existsSync(journalPath)) return;
  const journal = readJournal(journalPath);
  const db = store.db;
  ensureAuditOutboxSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    maxMeta(db, 'clear_seq', journal.clear_seq);
    maxMeta(db, 'clear_gen', journal.clear_gen);
    maxMeta(db, 'gen_high', journal.gen_high);
    maxMeta(db, 'binding_epoch', journal.binding_epoch);
    const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM audit_outbox').get() as { value: number };
    setMeta(db, 'next_seq', Math.max(meta(db, 'next_seq'), journal.seq_high, num(maxRow.value) + 1));
    if (journal.lease !== null) {
      maxMeta(db, 'gen_high', journal.lease.generation);
      const current = readLease(db);
      // Restore may start from a NEWER binding than the journal. Never drag
      // ownership backward just because a journal file is present.
      if (current === null || journal.lease.generation > current.generation) {
        db.prepare(`INSERT INTO audit_outbox_binding(singleton, prefix, generation, senders) VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET prefix=excluded.prefix, generation=excluded.generation, senders=excluded.senders`)
          .run(journal.lease.prefix, journal.lease.generation, JSON.stringify(journal.lease.senders));
      }
    }
    for (const entry of journal.pending) {
      if (entry.seq <= meta(db, 'clear_seq')) continue;
      const existing = db.prepare('SELECT 1 FROM audit_outbox WHERE event_id = ?').get(entry.envelope.eventId);
      if (existing !== undefined) continue;
      const seqTaken = db.prepare('SELECT 1 FROM audit_outbox WHERE seq = ?').get(entry.seq);
      if (seqTaken === undefined) {
        db.prepare('INSERT INTO audit_outbox(event_id, seq, event, subject, occurred_at) VALUES (?, ?, ?, ?, ?)')
          .run(entry.envelope.eventId, entry.seq, entry.envelope.event, entry.envelope.subject, entry.envelope.occurredAt);
      } else {
        // A restored backup can own the same sequence for a different event.
        // Reallocate above the merged high-water rather than dropping either.
        appendInTx(db, entry.envelope);
      }
    }
    for (const entry of journal.fallback) {
      if (entry.gen < meta(db, 'clear_gen')) continue;
      appendInTx(db, entry.envelope);
    }
    db.exec('COMMIT');
    // Keep the journal as an idempotent recovery snapshot. Replaying it is
    // safe: watermarks max-merge, pending rows INSERT OR IGNORE, and fallback
    // appends dedupe by eventId. Several restore arms reuse one journal.
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

function currentStore(getStore: () => StoreLike | null): StoreLike {
  const store = getStore();
  if (store === null) throw new Error('audit outbox store is unavailable');
  return store;
}

function notifyAfterCommit(db: SqliteDb, notify: Notify | undefined): void {
  if (notify === undefined) return;
  const run = (): void => {
    const current = readLease(db);
    const count = num((db.prepare('SELECT COUNT(*) AS value FROM audit_outbox').get() as { value: number }).value);
    notify({ generation: current?.generation ?? 0, pendingCount: count });
  };
  // Pack transactions are synchronous: the microtask runs after COMMIT returns.
  if (db.inTransaction) queueMicrotask(run);
  else run();
}

export function createProductionAuditSink(
  getStore: () => StoreLike | null,
  notify: Notify,
): { emit(envelope: DesktopAuditEnvelope): void } {
  if (typeof getStore !== 'function') throw new Error('audit sink requires a callable getStore');
  return {
    emit(envelope: DesktopAuditEnvelope): void {
      const store = currentStore(getStore);
      if (store.db.inTransaction) appendInTx(store.db, envelope);
      else appendStandalone(store, envelope);
      notifyAfterCommit(store.db, notify);
    },
  };
}

export function createProductionCustodySink(
  getStore: () => StoreLike | null,
  notify?: Notify,
): CustodyProvider {
  if (typeof getStore !== 'function') throw new Error('custody sink requires a callable getStore');
  return {
    beginRequest(): CustodyBatch {
      const pending: DesktopAuditEnvelope[] = [];
      let done = false;
      return {
        capture(envelope: DesktopAuditEnvelope): void { pending.push({ ...envelope }); },
        async flush(): Promise<void> {
          if (done) return;
          done = true;
          if (pending.length === 0) return;
          const store = currentStore(getStore);
          store.db.exec('BEGIN IMMEDIATE');
          try {
            for (const envelope of pending) appendInTx(store.db, envelope);
            store.db.exec('COMMIT');
          } catch (error) {
            try { store.db.exec('ROLLBACK'); } catch { /* preserve original */ }
            pending.length = 0;
            throw error;
          }
          pending.length = 0;
          notifyAfterCommit(store.db, notify);
        },
        discard(): void { pending.length = 0; done = true; },
      };
    },
  };
}

export function adaptLegacyCustodySink(
  sink: CustodyProvider | { capture(envelope: DesktopAuditEnvelope): void; flush(): void | Promise<void>; discard(): void },
): CustodyProvider {
  if ('beginRequest' in sink && typeof sink.beginRequest === 'function') return sink;
  const legacy = sink as { capture(envelope: DesktopAuditEnvelope): void; flush(): void | Promise<void>; discard(): void };
  return {
    beginRequest(): CustodyBatch {
      let done = false;
      return {
        capture(envelope: DesktopAuditEnvelope): void { legacy.capture(envelope); },
        async flush(): Promise<void> { if (!done) { done = true; await legacy.flush(); } },
        discard(): void { if (!done) { done = true; legacy.discard(); } },
      };
    },
  };
}
