/**
 * Local governance audit log (issue #366, WI5).
 *
 * An append-only, PROFILE-SCOPED, LOCAL-ONLY, BOUNDED event record persisted
 * under its own IndexedDB database (`{prefix}-doc-qa-audit`), SEPARATE from
 * the conversations Dexie store (separate table, separate lifecycle - the
 * issue is explicit that the conversations store is a persistence NEIGHBOR,
 * not the audit sink).
 *
 * PROPOSED policy (issue #366 AC3 - retention window, roster, and
 * non-exportability gate on the maintainer's review; quoted verbatim in
 * CONFIGURATION.md and the PR body):
 *   - retention: AUDIT_RETENTION_DAYS = 90;
 *   - roster: app_start/app_stop, pack_install/pack_remove (browser runtime),
 *     settings_change (governance keys), clear_cache, audit_log_cleared;
 *   - non-exportable by default (NO export path; export is a later decision);
 *   - NEVER conversation content - subject is a stable id / settings key.
 *
 * v1 roster is RENDERER-OBSERVED by design (see the plan B8 disclosed
 * exclusions): producers are places where the renderer truthfully observes
 * the commit. Backend-process pack commits + main-only settings writes are
 * excluded and tracked by a follow-up issue.
 */

import Dexie, { type Table } from 'dexie';
import { getStorageDbNames } from '../lib/storage/profile';

/** PROPOSED retention window (issue #366 AC2). */
export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The audit viewer renders at most this many (most recent) rows. */
export const AUDIT_VIEWER_ROW_LIMIT = 50;

/** Event roster (PROPOSED). subject is a stable id / settings key; never a
 *  value and never conversation content. */
export type AuditEventClass =
  | 'app_start'
  | 'app_stop'
  | 'pack_install'
  | 'pack_remove'
  | 'settings_change'
  | 'clear_cache'
  | 'audit_log_cleared';

/** Stored row. `seq` is Dexie's auto-increment key. `ts` is the occurrence
 *  time (ms epoch) supplied by the producer at the commit point. */
export interface AuditRow {
  seq?: number;
  ts: number;
  event: AuditEventClass;
  subject: string | null;
  /** Outbox identity and main-side ordering/ownership (#373). */
  eventId?: string;
  source_seq?: number | null;
  source_gen?: number;
}

interface AuditMetaRow {
  key: string;
  value: number | string;
}

class AuditDatabase extends Dexie {
  events!: Table<AuditRow, number>;
  meta!: Table<AuditMetaRow, string>;

  constructor(name?: string) {
    // The name parameter is a test seam (mirrors db/index.ts DocQADatabase):
    // production derives from the active profile prefix.
    super(name ?? getStorageDbNames().audit);
    this.version(1).stores({
      events: '++seq, ts, event',
    });
    // Additive subscriber schema (#373 AC3): existing v1 rows remain valid;
    // eventId dedup, source sequencing and generation ownership are optional
    // on legacy rows and populated by the outbox commit path.
    this.version(2).stores({
      events: '++seq, ts, event, eventId, source_seq, source_gen',
      meta: 'key',
    });
  }
}

/**
 * Module singleton. Tests re-import under vi.resetModules + fake-indexeddb +
 * a per-test unique profile prefix (repo recipe) so each test drives an
 * isolated database.
 */
export const auditDb = new AuditDatabase();

/**
 * Append one audit row, purging rows strictly older than the retention window
 * FIRST (purge-on-write, AC2). A row whose `ts` is exactly at the window
 * boundary survives (below(cutoff) is strict). The append and the purge run in
 * one readwrite transaction so a racing reader never observes a partially
 * purged table.
 *
 * `ts` is the row's occurrence time. `nowMs` is the WRITE-time clock the
 * retention cutoff is evaluated against (defaults to Date.now()); the test
 * seam pins both sides of the boundary deterministically without fake timers
 * (fake-indexeddb transactions are timer-scheduled and deadlock under them).
 */
export async function appendAuditEvent(
  event: AuditEventClass,
  subject: string | null,
  ts: number = Date.now(),
  nowMs: number = Date.now(),
): Promise<void> {
  const cutoff = nowMs - AUDIT_RETENTION_MS;
  await auditDb.transaction('rw', auditDb.events, async () => {
    await auditDb.events.where('ts').below(cutoff).delete();
    await auditDb.events.add({ ts, event, subject });
  });
}

/**
 * Producer-facing fire-and-forget wrapper (plan B6 failure isolation): the
 * returned promise is caught-and-swallowed so an audit-write failure NEVER
 * enters a producer's own cleanup region, misreports an operation, or flips a
 * displayed result. Producers call this at their commit point and do not await
 * it (except clear-cache / audit-clear, which await it before their reload).
 */
export function recordAuditEvent(
  event: AuditEventClass,
  subject: string | null,
  ts: number = Date.now(),
): Promise<void> {
  return appendAuditEvent(event, subject, ts).catch((err) => {
    // Swallow: a governance-log write failure must not break the audited
    // operation. Logged at debug only (no conversation content in the message).
    console.debug('[audit] append failed (swallowed)', event, err instanceof Error ? err.name : String(err));
  });
}

/** Newest-first bounded chronological view for the Settings audit surface. */
export async function listAuditEvents(limit: number = AUDIT_VIEWER_ROW_LIMIT): Promise<AuditRow[]> {
  const rows = await auditDb.events.orderBy('seq').reverse().limit(limit).toArray();
  // Return chronological (oldest->newest) so the viewer reads as a timeline.
  return rows.reverse();
}

/** Total stored row count (bounded; for the viewer header). */
export async function countAuditEvents(): Promise<number> {
  return auditDb.events.count();
}

/**
 * Destroy the governance record: purge every row, THEN append one
 * `audit_log_cleared` marker so the clearing itself is auditable (appended
 * AFTER the purge resolves). The two run in one transaction so a racing
 * reader sees either the old rows or the single marker row, never an empty
 * table mid-clear.
 */
export async function clearAuditLog(): Promise<void> {
  const bridge = window.desktopApi;
  const beforeClear = bridge?.auditBeforeClear;
  let desktopClear: { clearSeq: number; clearGen: number } | null = null;
  if (beforeClear !== undefined) {
    // Dynamic import avoids a module cycle: the listener consumes outbox rows,
    // which in turn use this database. The function runs after both are loaded.
    const { getActiveAuditOutboxContext } = await import('./audit-outbox-listener');
    const context = getActiveAuditOutboxContext();
    if (context !== null) desktopClear = await beforeClear(context.generation, context.sender);
  }
  const cutoff = Date.now() - AUDIT_RETENTION_MS;
  await auditDb.transaction('rw', auditDb.events, auditDb.meta, async () => {
    if (desktopClear !== null) {
      await auditDb.events.where('source_seq').belowOrEqual(desktopClear.clearSeq).delete();
      await auditDb.events.filter((row) => row.source_seq === undefined || row.source_seq === null).delete();
      await auditDb.meta.put({ key: 'audit_clear_seq', value: desktopClear.clearSeq });
      await auditDb.meta.put({ key: 'audit_clear_gen', value: desktopClear.clearGen });
    } else {
      await auditDb.events.clear();
    }
    await auditDb.events.add({ ts: Date.now(), event: 'audit_log_cleared', subject: null });
    // The marker is fresh so it is never purged; still honor the boundary.
    await auditDb.events.where('ts').below(cutoff).delete();
  });
}
