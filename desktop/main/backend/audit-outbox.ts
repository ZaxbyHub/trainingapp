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

/** Tombstone count at which one process-lifetime growth warning is emitted. */
const ACK_JOURNAL_WARN_THRESHOLD = 5000;
let ackJournalSizeWarned = false;

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
  expectedEpoch?: number,
): Promise<{ prefix: string; generation: number }> {
  const db = store.db;
  ensureAuditOutboxSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (expectedEpoch !== undefined && meta(db, 'binding_epoch') !== expectedEpoch) {
      throw new Error('audit subscribe epoch was superseded');
    }
    const current = readLease(db);
    if (current !== null && current.prefix === prefix) {
      // A renderer reload keeps the same webContents id but creates a new
      // sender. Replace the prior identity atomically so it cannot leak in the
      // sender set and prevent last-window invalidation forever.
      const senders = current.senders.filter((value) => value !== previousSender);
      if (!senders.includes(sender)) senders.push(sender);
      const retiredSender = previousSender !== undefined && previousSender !== sender && current.senders.includes(previousSender)
        ? previousSender
        : undefined;
      if (senders.length !== current.senders.length || senders.some((value, index) => value !== current.senders[index])) {
        db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1')
          .run(JSON.stringify(senders));
      }
      if (retiredSender !== undefined && store.dbPath !== undefined) {
        // Renderer reload retires the previous sender at the SAME generation.
        // Persist that retirement before COMMIT so restored pre-reload bytes
        // cannot resurrect the retired identity on the next store open.
        const journalPath = defaultAuditJournalPath(store.dbPath);
        const journal = readJournal(journalPath);
        if (!journal.removed_senders.some((delta) =>
          delta.sender === retiredSender && delta.prefix === current.prefix && delta.generation === current.generation)) {
          journal.removed_senders.push({ sender: retiredSender, prefix: current.prefix, generation: current.generation });
          journal.gen_high = Math.max(journal.gen_high, current.generation);
          writeJournal(journalPath, journal);
        }
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
    // Every committed sender removal (partial AND final) advances the epoch:
    // a restart journal that witnessed a removal the database lost (failed
    // COMMIT) reconciles by holding a strictly newer epoch, while a stale
    // snapshot can never exceed the committed epoch and so can never erase a
    // newer valid lease or shrink a live sender set.
    const nextEpoch = meta(db, 'binding_epoch') + 1;
    // The journal is a restart carrier. Update it before COMMIT so a destroyed
    // sender cannot be resurrected from an older snapshot on the next launch.
    // gen_high records the newest generation this removal applies to, so a
    // binding allocated AFTER the journal write is never erased by it. The
    // removal is journaled as a scoped DELTA (the destroyed sender id and the
    // prefix/generation it applied to) so replay removes exactly that sender
    // even when later senders bound the same prefix/generation after the
    // failed COMMIT — and even when a later removal commits the SAME next
    // epoch computed from the same rolled-back base. The delta PERSISTS past
    // its own successful COMMIT: restored same-generation pre-removal bytes
    // must replay the removal, and a re-bound sender id is fail-closed
    // (refused at the delivery gate, re-subscribed by its reconcile loop).
    if (store.dbPath !== undefined) {
      const journal = readJournal(defaultAuditJournalPath(store.dbPath));
      journal.lease = nextBinding;
      journal.gen_high = Math.max(journal.gen_high, current.generation);
      journal.binding_epoch = Math.max(journal.binding_epoch, nextEpoch);
      if (!journal.removed_senders.some(
        (delta) => delta.sender === sender && delta.prefix === current.prefix && delta.generation === current.generation,
      )) {
        journal.removed_senders.push({ sender, prefix: current.prefix, generation: current.generation });
      }
      writeJournal(defaultAuditJournalPath(store.dbPath), journal);
    }
    if (senders.length === 0) {
      db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
      setMeta(db, 'binding_epoch', nextEpoch);
      db.exec('COMMIT');
      return true;
    }
    db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1').run(JSON.stringify(senders));
    setMeta(db, 'binding_epoch', nextEpoch);
    db.exec('COMMIT');
    return false;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

/** Revoke a namespace before its audit database is deleted. */
export function revokeOutboxNamespace(store: StoreLike, prefix: string): ReturnType<typeof readOutboxBindingState> {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readLease(db);
    const revokedGeneration = current?.prefix === prefix ? current.generation : null;
    if (current?.prefix === prefix) db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
    setMeta(db, 'gen_high', meta(db, 'gen_high') + 1);
    setMeta(db, 'binding_epoch', meta(db, 'binding_epoch') + 1);
    const next = readLease(db);
    if (store.dbPath !== undefined) {
      const journalPath = defaultAuditJournalPath(store.dbPath);
      const journal = readJournal(journalPath);
      journal.lease = next;
      journal.gen_high = Math.max(journal.gen_high, meta(db, 'gen_high'));
      journal.binding_epoch = Math.max(journal.binding_epoch, meta(db, 'binding_epoch'));
      // Revocation is a whole-prefix invalidation AT THE REVOKED GENERATION:
      // it supersedes per-sender removal deltas scoped to exactly the
      // (revoked prefix, revoked generation) being deleted outright. Deltas
      // scoped to other prefixes — OR TO OTHER GENERATIONS of the same
      // prefix — are removal evidence that must survive, so restored
      // older-generation bytes still replay their removals.
      journal.removed_senders = journal.removed_senders.filter(
        (delta) => revokedGeneration === null || delta.prefix !== prefix || delta.generation !== revokedGeneration,
      );
      // The revocation itself is recorded as its OWN generation-scoped entry:
      // journal.lease cannot carry it durably (a later committed sender
      // removal overwrites the lease with the surviving post-state), and the
      // entry reconciles by (prefix, generation) presence alone.
      if (revokedGeneration !== null && !journal.revoked.some((entry) => entry.prefix === prefix && entry.generation === revokedGeneration)) {
        journal.revoked.push({ prefix, generation: revokedGeneration });
      }
      writeJournal(journalPath, journal);
    }
    db.exec('COMMIT');
    return readOutboxBindingState(store);
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
    // F-002 (renderer-commit contract): the renderer acks only AFTER its own
    // IndexedDB delivery commit (web_ui/src/db/audit-outbox.ts), so an
    // AUTHORIZED ack is itself the delivery commit point — the main-process
    // DELETE below is cleanup. The tombstone is written before that cleanup,
    // in the same write that strikes the journal's pending/fallback
    // snapshots, and is NEVER withdrawn: a cleanup DELETE/COMMIT failure
    // surfaces to the caller, but reopen must not redeliver an event the
    // renderer already committed, and restored pre-ack bytes stay suppressed.
    // Unauthorized repeats reject at assertAuthorized BEFORE any journal
    // mutation, so they cannot disturb an existing tombstone.
    if (store.dbPath !== undefined) {
      const journalPath = defaultAuditJournalPath(store.dbPath);
      const journal = readJournal(journalPath);
      const pendingBefore = journal.pending.length;
      const fallbackBefore = journal.fallback.length;
      const ackedBefore = journal.acked.length;
      journal.pending = journal.pending.filter((entry) => entry.envelope.eventId !== eventId);
      journal.fallback = journal.fallback.filter((entry) => entry.envelope.eventId !== eventId);
      if (!journal.acked.includes(eventId)) journal.acked.push(eventId);
      if (journal.pending.length !== pendingBefore || journal.fallback.length !== fallbackBefore || journal.acked.length !== ackedBefore) {
        writeJournal(journalPath, journal);
      }
      // PR #391 F-005: tombstones are retained forever by design (they stop a
      // restored pre-ack backup from redelivering), and each ack rewrites the
      // whole journal synchronously. The volume is small, so this is a growth
      // warning rather than pruning: pruning by count would resurrect the
      // duplicate-delivery class F-002 closed.
      if (!ackJournalSizeWarned && journal.acked.length >= ACK_JOURNAL_WARN_THRESHOLD) {
        ackJournalSizeWarned = true;
        console.warn(
          `[audit-outbox] ack tombstone journal reached ${String(journal.acked.length)} entries; growth is bounded only by daily event volume (see CONFIGURATION.md retention notes)`,
        );
      }
    }
    const result = db.prepare('DELETE FROM audit_outbox WHERE event_id = ?').run(eventId);
    db.exec('COMMIT');
    return Number(result.changes) > 0;
  } catch (error) {
    // The tombstone (if this call wrote one) STANDS: the renderer already
    // committed delivery. Only the cleanup transaction is rolled back.
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
  /**
   * Outstanding sender-removal deltas (the destroyed sender ids, NOT a
   * post-state), each scoped to the prefix/generation it applied to. They
   * reconcile on PRESENCE against a matching live binding — independently of
   * the epoch relation — because a later removal can commit the SAME next
   * epoch computed from the same rolled-back base, which would hide the
   * outstanding delta behind an epoch-equality gate.
   */
  removed_senders: Array<{ sender: number; prefix: string; generation: number }>;
  /**
   * Durable acknowledged-event tombstones (eventIds), written BEFORE the ack
   * DELETE/COMMIT and NEVER withdrawn. Renderer-commit contract: the renderer
   * acks only after its own IndexedDB delivery commit, so an authorized ack
   * IS the delivery commit point and the main-process DELETE is cleanup — a
   * cleanup failure surfaces to the caller but reopen must not redeliver,
   * and restored pre-ack bytes stay suppressed. Unauthorized repeats reject
   * before any journal mutation and cannot disturb an existing tombstone.
   */
  acked: string[];
  /**
   * Generation-scoped revocation entries: the (prefix, generation) pairs
   * namespace revocation invalidated. They reconcile on PRESENCE against a
   * matching live binding — independently of journal.lease (which a later
   * committed sender removal overwrites with the surviving post-state) and of
   * the epoch relation (a same-next-epoch commit hides it). A newer-generation
   * rebind carries a different generation and is never touched.
   */
  revoked: Array<{ prefix: string; generation: number }>;
}

function emptyJournal(): Journal {
  return { pending: [], fallback: [], clear_seq: 0, clear_at: 0, clear_gen: 0, lease: null, seq_high: 1, gen_high: 0, binding_epoch: 0, removed_senders: [], acked: [], revoked: [] };
}

/**
 * PR #391 F-001: syntax-valid JSON with a wrong shape is just as unopenable as
 * a syntax error — the consumer would dereference null/missing fields inside
 * its transaction and rethrow. Validate every field the consumer reads,
 * including array ENTRIES, so shape failures route through the same
 * quarantine recovery instead of failing every launch.
 */
function requireEnvelope(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid audit journal shape: ${where} envelope is not an object`);
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.eventId !== 'string' || typeof envelope.event !== 'string' ||
      typeof envelope.subject !== 'string' || typeof envelope.occurredAt !== 'number') {
    throw new Error(`invalid audit journal shape: ${where} envelope fields`);
  }
}

function validateJournalShape(parsed: Partial<Journal>): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid audit journal shape: top level is not an object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ['pending', 'fallback', 'acked', 'removed_senders', 'revoked'] as const) {
    const value = record[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`invalid audit journal shape: ${key} is not an array`);
    }
  }
  for (const key of ['clear_seq', 'clear_at', 'clear_gen', 'seq_high', 'gen_high', 'binding_epoch'] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`invalid audit journal shape: ${key} is not a finite number`);
    }
  }
  const list = (key: string): unknown[] => (record[key] === undefined ? [] : record[key] as unknown[]);
  for (const entry of list('pending')) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).seq !== 'number') {
      throw new Error('invalid audit journal shape: pending entry');
    }
    requireEnvelope((entry as Record<string, unknown>).envelope, 'pending entry');
  }
  for (const entry of list('fallback')) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).gen !== 'number') {
      throw new Error('invalid audit journal shape: fallback entry');
    }
    requireEnvelope((entry as Record<string, unknown>).envelope, 'fallback entry');
  }
  for (const entry of list('acked')) {
    if (typeof entry !== 'string') throw new Error('invalid audit journal shape: acked entry');
  }
  for (const entry of list('removed_senders')) {
    const delta = entry as Record<string, unknown> | null;
    if (delta === null || typeof delta !== 'object' || typeof delta.sender !== 'number' ||
        typeof delta.prefix !== 'string' || typeof delta.generation !== 'number') {
      throw new Error('invalid audit journal shape: removed_senders entry');
    }
  }
  for (const entry of list('revoked')) {
    const revoked = entry as Record<string, unknown> | null;
    if (revoked === null || typeof revoked !== 'object' || typeof revoked.prefix !== 'string' ||
        typeof revoked.generation !== 'number') {
      throw new Error('invalid audit journal shape: revoked entry');
    }
  }
  const lease = record.lease;
  if (lease !== undefined && lease !== null) {
    if (typeof lease !== 'object' || Array.isArray(lease)) throw new Error('invalid audit journal shape: lease is not an object');
    const leaseRecord = lease as Record<string, unknown>;
    if (typeof leaseRecord.prefix !== 'string' || typeof leaseRecord.generation !== 'number' || !Array.isArray(leaseRecord.senders)) {
      throw new Error('invalid audit journal shape: lease fields');
    }
    for (const sender of leaseRecord.senders) {
      if (typeof sender !== 'number') throw new Error('invalid audit journal shape: lease sender');
    }
  }
}

function readJournal(journalPath: string): Journal {
  if (!fs.existsSync(journalPath)) return emptyJournal();
  const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<Journal>;
  validateJournalShape(parsed);
  return { ...emptyJournal(), ...parsed };
}

function writeJournal(journalPath: string, journal: Journal): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.${String(process.pid)}.${String(Math.random()).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal), 'utf8');
  // The rename below is atomic, but without an fsync the rename can outlive
  // the file contents on power loss, leaving an empty/partial journal the
  // next open cannot parse. Flush the bytes before publishing the name.
  const fd = fs.openSync(tmp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, journalPath);
}

/**
 * PR #391 F-001: a malformed restart journal must not take a healthy store
 * offline on every launch. Quarantine the bytes (evidence preserved), keep the
 * pending outbox rows untouched, and invalidate custody bindings so renderers
 * re-subscribe. Write paths still read strictly: an ack or removal must fail
 * closed rather than overwrite unread evidence.
 */
function recoverFromCorruptJournal(store: StoreLike, journalPath: string, error: unknown): void {
  const db = store.db;
  ensureAuditOutboxSchema(db);
  // Commit the fail-closed recovery FIRST: if it rolls back, the corrupt
  // journal is still at its original path and the next open retries recovery
  // instead of silently keeping a stale binding. Quarantining afterwards is
  // idempotent-safe: if the rename fails, the next open repeats the (already
  // committed) invalidation.
  db.exec('BEGIN IMMEDIATE');
  try {
    maxMeta(db, 'gen_high', meta(db, 'gen_high') + 1);
    maxMeta(db, 'binding_epoch', meta(db, 'binding_epoch') + 1);
    db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
    db.exec('COMMIT');
  } catch (recoveryError) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw recoveryError;
  }
  const quarantined = `${journalPath}.corrupt-${Date.now()}`;
  let quarantine = quarantined;
  try {
    fs.renameSync(journalPath, quarantined);
  } catch (renameError) {
    quarantine = `quarantine failed: ${renameError instanceof Error ? renameError.name : String(renameError)}`;
  }
  console.warn(
    '[audit-outbox] restart journal quarantined; custody bindings invalidated and pending rows retained:',
    error instanceof Error ? error.name : String(error),
    quarantine,
  );
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
  let journal: Journal;
  try {
    journal = readJournal(journalPath);
  } catch (error) {
    recoverFromCorruptJournal(store, journalPath, error);
    return;
  }
  const db = store.db;
  ensureAuditOutboxSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    // F-003: capture the live lease BEFORE max-merging. Sender-removal deltas
    // and revocation entries reconcile on PRESENCE against the matching
    // prefix/generation — a later removal or revocation can commit the SAME
    // next epoch computed from the same rolled-back base, so an epoch
    // comparison alone cannot gate either.
    const live = readLease(db);
    maxMeta(db, 'clear_seq', journal.clear_seq);
    maxMeta(db, 'clear_gen', journal.clear_gen);
    maxMeta(db, 'gen_high', journal.gen_high);
    maxMeta(db, 'binding_epoch', journal.binding_epoch);
    const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM audit_outbox').get() as { value: number };
    setMeta(db, 'next_seq', Math.max(meta(db, 'next_seq'), journal.seq_high, num(maxRow.value) + 1));
    const lease = journal.lease;
    if (lease !== null) maxMeta(db, 'gen_high', lease.generation);
    const leaseRevoked = lease !== null && journal.revoked.some((entry) => entry.prefix === lease.prefix && entry.generation === lease.generation);
    // Restore may start from a NEWER binding than the journal. Never drag
    // ownership backward just because a journal file is present, and never
    // resurrect a lease whose (prefix, generation) a revocation entry killed.
    if (lease !== null && !leaseRevoked && (live === null || lease.generation > live.generation)) {
      db.prepare(`INSERT INTO audit_outbox_binding(singleton, prefix, generation, senders) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET prefix=excluded.prefix, generation=excluded.generation, senders=excluded.senders`)
        .run(lease.prefix, lease.generation, JSON.stringify(lease.senders));
      // F-003: the installed lease is now the EFFECTIVE lease — outstanding
      // sender-removal deltas scoped to ITS (prefix, generation) apply to it
      // too, so a restored/empty database cannot resurrect a destroyed sender
      // inside the installed lease.
      const installScoped = journal.removed_senders.filter(
        (delta) => delta.prefix === lease.prefix && delta.generation === lease.generation,
      );
      if (installScoped.length > 0) {
        const survivors = lease.senders.filter((id) => !installScoped.some((delta) => delta.sender === id));
        if (survivors.length === 0) {
          db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
        } else {
          db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1')
            .run(JSON.stringify(survivors));
        }
      }
    } else if (live !== null) {
      if (journal.revoked.some((entry) => entry.prefix === live.prefix && entry.generation === live.generation)) {
        // Namespace revocation, preserved independently of journal.lease (a
        // later committed sender removal overwrites the lease) and of the
        // epoch relation: the entry invalidates the binding at exactly its
        // (prefix, generation). A newer-generation rebind carries a different
        // generation and is never touched.
        db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
      } else {
        const scoped = journal.removed_senders.filter(
          (delta) => delta.prefix === live.prefix && delta.generation === live.generation,
        );
        if (scoped.length > 0) {
          // Outstanding sender-removal deltas reconcile on PRESENCE against
          // the matching prefix/generation. Replay removes exactly the
          // destroyed sender ids: senders bound to the same
          // prefix/generation after the failed removal survive, and the
          // binding clears only when none remain. Deltas scoped to other
          // prefixes/generations never touch this binding.
          const survivors = live.senders.filter((id) => !scoped.some((delta) => delta.sender === id));
          if (survivors.length === 0) {
            db.prepare('DELETE FROM audit_outbox_binding WHERE singleton = 1').run();
          } else {
            db.prepare('UPDATE audit_outbox_binding SET senders = ? WHERE singleton = 1')
              .run(JSON.stringify(survivors));
          }
        }
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
    // F-002: durable renderer-ack tombstones — the renderer writes its own
    // IndexedDB row before sending the ack, so the main-process DELETE is only
    // cleanup. Whatever bytes the database carries — the normal lineage or
    // pre-ack bytes restored from a backup — rows whose eventId was
    // acknowledged are deleted here; unacknowledged events keep replaying.
    for (const eventId of journal.acked) {
      db.prepare('DELETE FROM audit_outbox WHERE event_id = ?').run(eventId);
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
