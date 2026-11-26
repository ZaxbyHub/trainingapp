// frozen-check C6 — #373 AC3: the outbox delivery mechanism pins
// exactly-once semantics on the SUBSCRIBER side — reload-gap redelivery,
// transactional eventId dedup, failed-append retry, ack-only-after-commit,
// and (rev 3) adoption-refused renderer compensation.
//
// FROZEN SPEC (rev 3, critic Round-11 R11-6 amendment of rev 2) — authored
// by the independent check author at base 54107572c092febc00beff17f719ff631a2215ac,
// before any implementation exists. The implementer must make this pass
// WITHOUT editing it; the canonical copy lives in the issue trace and is
// dropped into the repo byte-identical at
// web_ui/src/db/__tests__/audit-outbox.test.ts.
//
// REV 2 CHANGE (retention collision fix): rev 1's literal occurredAt values
// (Nov-2024 epoch ms) sat far OUTSIDE the audit sink's 90-day purge-on-write
// retention window (audit.ts appendAuditEvent deletes rows with ts < now -
// 90d BEFORE each add), so the reload-gap/duplicate legs could never go
// green — every new append purged the older fixture row. Every envelope's
// occurredAt now derives from ONE Date.now() capture per test with fixed
// small offsets (deterministic within the run, always far inside the
// retention window). No production retention behavior is touched.
//
// REV 3 CHANGE (critic Round 11, 06 :1022-1028, R11-6; plan v12 Part 4
// item 5 + `Critic Round 11 Responses` R11-6): the adoption/compensation
// proof lived only on the MAIN side (the C4 stale-generation ack rejection)
// — it never executed the REAL renderer sequence in Dexie. Rev 3 adds the
// RENDERER COMPENSATION leg: a gen5 delivery inserts the row
// (source_gen = 5) and PAUSES before its post-commit generation re-check;
// the binding is superseded; the gen6 redelivery of the SAME eventId
// dedup-hits, MONOTONIC ADOPTION re-stamps source_gen 5 -> 6 (6 > 5,
// currently authorized), and acks; gen5 resumes its post-commit check and
// its compensating delete is REFUSED (the row's CURRENT source_gen is 6,
// not 5) — the Dexie row SURVIVES (raw read: exactly one row,
// source_gen === 6). A CONTROL leg proves an UN-ADOPTED stale-gen row IS
// compensated (deleted), so the main leg's refusal is caused by adoption,
// not by a no-op compensation. The harness contract gains the OPTIONAL
// second argument on appendAuditEnvelope (all rev-2 one-argument call
// sites stay valid), the { inserted } return, source_gen stamping +
// monotonic adoption, the compensating-delete export, and the delivery
// flow's post-commit re-check seam — declared below exactly like the
// existing contract block.
//
// RED at base (the spec file does not exist there — vitest's file-absent
// signature is `No test files found`; the issue's `-t audit-outbox` filter
// also matches these tests by name), GREEN after the fix.
//
// Harness contract (declared for the implementer, like the at-rest spec's
// harness-contract block — the minimal SUBSCRIBER-side seam):
//   - web_ui/src/db/audit-outbox.ts exports:
//       export interface OutboxEnvelope {
//         eventId: string;          // producer-minted, unique per COMMIT
//         event: AuditEventClass;   // roster event name (audit.ts)
//         subject: string | null;   // stable id / settings key
//         occurredAt: number;       // producer commit time, ms epoch
//       }
//       export type AuditSink = (envelope: OutboxEnvelope) => Promise<void>;
//       // The Dexie COMMIT POINT: appends the audit row for the envelope
//       // EXACTLY ONCE per eventId (transactional dedup inside Dexie — the
//       // envelope's eventId must never yield a second row, whatever store
//       // shape the implementation uses to remember it). The appended row
//       // records ts = occurredAt, event, subject.
//       // REV 3: returns { inserted } — true only when THIS call created
//       // the row, false on a dedup hit; when options.generation is given,
//       // the inserted row is stamped source_gen = options.generation, and
//       // a DEDUP HIT with options.generation > the row's current
//       // source_gen RE-STAMPS the row (MONOTONIC adoption — a lower
//       // generation can never overwrite a higher one) in the SAME Dexie
//       // transaction. The one-argument call sites of rev 2 stay valid.
//       export async function appendAuditEnvelope(
//         envelope: OutboxEnvelope,
//         options?: { generation?: number },
//       ): Promise<{ inserted: boolean }>;
//       // REV 3: the delivery flow's COMPENSATING DELETE (plan Part 4 v12
//       // item 6): one atomic Dexie tx = read-by-eventId +
//       // source_gen === generation check + delete (no check/delete gap).
//       // Resolves true when the row was deleted; FALSE when REFUSED (no
//       // such row, or another generation ADOPTED it — source_gen moved).
//       export async function compensateAuditInsert(
//         eventId: string,
//         generation: number,
//       ): Promise<boolean>;
//       // Queue source with pending/ack primitives (main->renderer channel
//       // abstraction; production supplies the real channel, this spec an
//       // in-memory one):
//       export interface OutboxQueue {
//         pending(): Promise<OutboxEnvelope[]>;  // not-yet-acked; redelivered on subscribe
//         ack(eventId: string): Promise<void>;   // recorded ONLY after the append committed
//         // REV 3 OPTIONAL member: the delivery flow's post-commit
//         // generation re-check. When BOTH this and the delivery's
//         // options.generation are present, the flow re-checks AFTER the
//         // sink returns and BEFORE ack: a MISMATCH (the binding moved)
//         // compensates via compensateAuditInsert(eventId,
//         // options.generation) and does NOT ack; a match acks. Queues
//         // without it keep the rev-2 legacy behavior.
//         currentGeneration?(): number | Promise<number>;
//       }
//       // Subscribe-and-drain: delivers every pending envelope to the sink
//       // (default sink: appendAuditEnvelope), acking each envelope only
//       // after its append COMMITTED; a sink that throws leaves the envelope
//       // pending (redelivered on the next drain). May reject on sink
//       // failure; the caller catches and retries.
//       // REV 3: gains the OPTIONAL options bag ({ generation? }) feeding
//       // the post-commit re-check above; two-argument call sites stay
//       // valid.
//       export function deliverPendingOutbox(
//         queue: OutboxQueue,
//         sink?: AuditSink,
//         options?: { generation?: number },
//       ): Promise<void>;
//   - The audit Dexie store itself stays web_ui/src/db/audit.ts's
//     ({prefix}-doc-qa-audit, AuditRow shape); the dedup is part of the
//     outbox commit, not a renderer-side filter.
//
// Harness recipe: fake-indexeddb/auto + per-test UNIQUE profile prefix +
// vi.resetModules + dynamic import AFTER the prefix is pinned (the audit
// singleton captures its DB name at import — the repo recipe, audit-log.test.ts).
import 'fake-indexeddb/auto';
import { describe, test, expect, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import type { AuditEventClass } from '../audit';

/**
 * The declared OutboxEnvelope shape, spelled locally (audit.ts's
 * AuditEventClass is real at base) so the in-memory queue below is
 * structurally assignable to the declared OutboxQueue interface.
 */
interface OutboxEnvelopeLike {
  eventId: string;
  event: AuditEventClass;
  subject: string | null;
  occurredAt: number;
}

let prefixCounter = 0;

/** EXACTLY 8 lowercase-alnum chars (the profile prefix shape regex). */
function nextPrefix(): string {
  prefixCounter += 1;
  return 'ao' + String(prefixCounter).padStart(6, '0');
}

type OutboxModule = typeof import('../audit-outbox');

async function freshOutbox(prefix: string): Promise<OutboxModule> {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  return import('../audit-outbox');
}

async function auditDbName(prefix: string): Promise<string> {
  localStorage.setItem(PROFILE_KEY, prefix);
  const profile = await import('../../lib/storage/profile');
  return profile.getStorageDbNames().audit;
}

/** RAW read of every row in the audit events store, bypassing Dexie. */
function rawAuditRows(dbName: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains('events')) {
        conn.close();
        resolve([]);
        return;
      }
      const tx = conn.transaction('events', 'readonly');
      const getAll = tx.objectStore('events').getAll();
      getAll.onsuccess = () => {
        conn.close();
        resolve((getAll.result as Array<Record<string, unknown>>) ?? []);
      };
      getAll.onerror = () => {
        conn.close();
        reject(getAll.error ?? new Error('raw getAll failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

/** Rows matching one envelope's observable audit tuple. */
function rowsFor(
  rows: Array<Record<string, unknown>>,
  envelope: OutboxEnvelopeLike,
): Array<Record<string, unknown>> {
  return rows.filter(
    (r) => r.event === envelope.event && r.subject === envelope.subject && r.ts === envelope.occurredAt,
  );
}

/**
 * The declared queue source as an in-memory channel: envelopes queued by a
 * producer (possibly while NO subscriber was attached — the reload gap),
 * redelivered by pending() until acked. REV 3: the OPTIONAL
 * currentGeneration member of the declared OutboxQueue — the leg flips it
 * to simulate the main-side binding takeover the post-commit re-check sees.
 */
class MemoryOutboxQueue {
  private readonly envelopes: OutboxEnvelopeLike[] = [];
  private readonly acked = new Set<string>();
  /** ack() observes this hook before recording (ordering assertions). */
  onAck?: (eventId: string) => void | Promise<void>;
  /** REV 3: the delivery flow's post-commit generation re-check source. */
  currentGeneration?: () => number;

  enqueue(envelope: OutboxEnvelopeLike): void {
    this.envelopes.push(envelope);
  }

  ackedIds(): string[] {
    return [...this.acked];
  }

  async pending(): Promise<OutboxEnvelopeLike[]> {
    return this.envelopes.filter((e) => !this.acked.has(e.eventId));
  }

  async ack(eventId: string): Promise<void> {
    await this.onAck?.(eventId);
    this.acked.add(eventId);
  }
}

/** A deterministic one-shot gate (no sleeps, no polling) — the rev-3 pause/signal seams. */
function makeGate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function env(eventId: string, event: AuditEventClass, subject: string | null, occurredAt: number): OutboxEnvelopeLike {
  return { eventId, event, subject, occurredAt };
}

describe('audit-outbox: exactly-once delivery on the subscriber side (issue #373 AC3)', () => {
  test('reload-gap: envelopes queued while no subscriber was attached are delivered on subscribe and appended exactly once (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const queue = new MemoryOutboxQueue();
    // Retention-safe timestamps: one Date.now() capture, fixed small offsets
    // (both far inside the 90-day purge-on-write window — see the rev-2 note).
    const t0 = Date.now();
    // The producer commits (pack install + remove) while NO subscriber is
    // attached — the envelopes sit in the channel across a renderer reload.
    const gap1 = env('evt-gap-1', 'pack_install', 'demo-pack@1.0.0', t0);
    const gap2 = env('evt-gap-2', 'pack_remove', 'demo-pack@1.0.0', t0 + 5_000);
    queue.enqueue(gap1);
    queue.enqueue(gap2);

    // The subscriber attaches (post-reload) and drains.
    await outbox.deliverPendingOutbox(queue);

    const rows = await rawAuditRows(await auditDbName(prefix));
    expect(rows.length, 'both queued envelopes are appended after the reload gap').toBe(2);
    expect(rowsFor(rows, gap1).length).toBe(1);
    expect(rowsFor(rows, gap2).length).toBe(1);
    // Redeliver-on-subscribe settled the channel: everything is acked and a
    // second drain finds nothing pending and appends nothing.
    expect(queue.ackedIds().sort()).toEqual(['evt-gap-1', 'evt-gap-2']);
    await outbox.deliverPendingOutbox(queue);
    expect((await rawAuditRows(await auditDbName(prefix))).length).toBe(2);
  });

  test('duplicate delivery: the same eventId delivered twice yields exactly ONE audit row (transactional Dexie dedup) (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const queue = new MemoryOutboxQueue();
    const t0 = Date.now();
    // The channel redelivers the SAME commit twice in one pending batch
    // (overlap of redelivery windows).
    const duplicate = env('evt-dup-1', 'pack_install', 'dup-pack@2.0.0', t0);
    queue.enqueue(duplicate);
    queue.enqueue({ ...duplicate });

    await outbox.deliverPendingOutbox(queue);

    const rows = await rawAuditRows(await auditDbName(prefix));
    expect(
      rowsFor(rows, duplicate).length,
      'duplicate delivery of one eventId must yield exactly ONE audit row',
    ).toBe(1);

    // Redelivery after ack loss: a fresh subscriber sees the same envelope
    // AGAIN and must still find exactly one row (the dedup is durable, not
    // per-drain).
    const replayQueue = new MemoryOutboxQueue();
    replayQueue.enqueue(duplicate);
    await outbox.deliverPendingOutbox(replayQueue);
    const rowsAfter = await rawAuditRows(await auditDbName(prefix));
    expect(
      rowsFor(rowsAfter, duplicate).length,
      'redelivery after ack loss must still find exactly ONE row',
    ).toBe(1);
  });

  test('failed-append retry: a failing append does not ack (envelope stays pending); a retry after recovery commits exactly one row (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const queue = new MemoryOutboxQueue();
    const t0 = Date.now();
    const failing = env('evt-retry-1', 'pack_remove', 'retry-pack@1.0.0', t0);
    queue.enqueue(failing);

    // Make the REAL Dexie commit point fail (the audit-log spec's own
    // failure-injection seam): the audit store's transaction rejects. The
    // declared contract routes every append through this audit.ts
    // singleton's transaction, so the spy fails the commit deterministically.
    const audit = await import('../audit');
    const spy = vi.spyOn(audit.auditDb, 'transaction').mockRejectedValue(new Error('idb down'));
    await outbox.deliverPendingOutbox(queue).catch(() => {
      /* the drain may reject on sink failure — the contract allows it */
    });
    spy.mockRestore();

    // No ack was recorded and no row landed: the envelope stays pending.
    expect(queue.ackedIds(), 'a failed append must NOT ack').toEqual([]);
    expect((await rawAuditRows(await auditDbName(prefix))).length).toBe(0);
    const stillPending = await queue.pending();
    expect(stillPending.map((e) => e.eventId), 'the envelope stays pending for redelivery').toEqual(['evt-retry-1']);

    // Recovery: the retry commits exactly one row and acks.
    await outbox.deliverPendingOutbox(queue);
    const rows = await rawAuditRows(await auditDbName(prefix));
    expect(rowsFor(rows, failing).length).toBe(1);
    expect(queue.ackedIds()).toEqual(['evt-retry-1']);
  });

  test('ack-only-after-commit: no ack is recorded before the append transaction commits (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const queue = new MemoryOutboxQueue();
    const t0 = Date.now();
    const ordered = env('evt-order-1', 'pack_install', 'order-pack@1.0.0', t0);
    queue.enqueue(ordered);

    const dbName = await auditDbName(prefix);
    // The queue's ack() side of the ordering contract: at ack time the
    // committed row must ALREADY be visible in the audit store.
    let ackSawCommittedRow = false;
    queue.onAck = async () => {
      const rows = await rawAuditRows(dbName);
      ackSawCommittedRow = rows.some(
        (r) => r.event === ordered.event && r.subject === ordered.subject && r.ts === ordered.occurredAt,
      );
    };
    // The sink side of the ordering contract: at append time the envelope
    // must NOT yet be acked.
    let sinkSawPrematureAck = false;
    const sink: Parameters<typeof outbox.deliverPendingOutbox>[1] = async (envelopeArg) => {
      sinkSawPrematureAck = queue.ackedIds().includes(envelopeArg.eventId);
      await outbox.appendAuditEnvelope(envelopeArg);
    };

    await outbox.deliverPendingOutbox(queue, sink);

    expect(sinkSawPrematureAck, 'no ack may be recorded before the append runs').toBe(false);
    expect(ackSawCommittedRow, 'the ack may only run after the append transaction committed').toBe(true);
    expect(queue.ackedIds()).toEqual(['evt-order-1']);
    expect(rowsFor(await rawAuditRows(dbName), ordered).length).toBe(1);
  });

  test('adoption-refused compensation (R11-6, rev 3): a gen5 delivery inserts (source_gen = 5) and PAUSES before its post-commit re-check; the gen6 redelivery of the SAME eventId dedup-hits and MONOTONIC ADOPTION re-stamps source_gen 5 -> 6, then acks; gen5 resumes and its compensating delete is REFUSED — the Dexie row SURVIVES with source_gen === 6 (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const dbName = await auditDbName(prefix);
    const t0 = Date.now();
    const envelope = env('evt-adopt-1', 'pack_install', 'adopt-pack@1.0.0', t0);

    // (1) The gen5 delivery: inserts the row with source_gen = 5, then PAUSES
    // before its post-commit re-check/ack (the sink holds the delivery
    // between the append commit and the re-check — a deterministic gate).
    const gen5Queue = new MemoryOutboxQueue();
    gen5Queue.enqueue(envelope);
    let gen = 5;
    gen5Queue.currentGeneration = () => gen;
    const insertedSignal = makeGate();
    const pause = makeGate();
    const gen5Sink: Parameters<typeof outbox.deliverPendingOutbox>[1] = async (delivered: OutboxEnvelopeLike) => {
      const inserted = await outbox.appendAuditEnvelope(delivered, { generation: 5 });
      expect(inserted.inserted, 'the gen5 delivery CREATED the row (inserted: true — the compensation ownership premise)').toBe(true);
      insertedSignal.open();
      await pause.promise;
    };
    const gen5Delivery = outbox.deliverPendingOutbox(gen5Queue, gen5Sink, { generation: 5 });
    await insertedSignal.promise; // the gen5 row is COMMITTED; the delivery stays paused before its re-check

    let rows = await rawAuditRows(dbName);
    expect(rows.length, 'exactly one row exists while gen5 is paused').toBe(1);
    expect(rows[0]!.source_gen, 'the inserted row is stamped with the DELIVERY generation (5) — plan Part 4 v12 item 6').toBe(5);

    // (2) The binding is superseded (the main-side takeover): the gen6
    // redelivery of the SAME eventId DEDUP-HITS, adoption re-stamps 5 -> 6
    // (monotonic: 6 > 5), and the gen6 delivery's re-check matches so it acks.
    const gen6Queue = new MemoryOutboxQueue();
    gen6Queue.enqueue({ ...envelope });
    gen6Queue.currentGeneration = () => 6;
    let gen6Inserted: { inserted: boolean } | null = null;
    await outbox.deliverPendingOutbox(
      gen6Queue,
      async (delivered: OutboxEnvelopeLike) => { gen6Inserted = await outbox.appendAuditEnvelope(delivered, { generation: 6 }); },
      { generation: 6 },
    );
    expect(gen6Inserted!.inserted, 'the gen6 redelivery is a DEDUP HIT — it must NOT create a second row').toBe(false);
    expect(gen6Queue.ackedIds(), 'the CURRENT generation\'s delivery acked (its post-commit re-check matched)').toEqual(['evt-adopt-1']);
    rows = await rawAuditRows(dbName);
    expect(rows.length, 'still exactly ONE row after the redelivery').toBe(1);
    expect(rows[0]!.source_gen, 'MONOTONIC ADOPTION re-stamped the row 5 -> 6 inside the append transaction (6 > 5; a backward re-stamp is impossible — plan Part 4 v12 item 6)').toBe(6);

    // (3) gen5 RESUMES its post-commit re-check: the binding moved (6 != 5),
    // so it must compensate — and the compensating delete is REFUSED because
    // the row's CURRENT source_gen (6) is no longer its generation (5).
    gen = 6; // the takeover is observable to the resumed delivery's re-check
    pause.open();
    await gen5Delivery;
    expect(gen5Queue.ackedIds(), 'the stale gen5 delivery did NOT ack under its superseded generation').toEqual([]);
    rows = await rawAuditRows(dbName);
    expect(rows.length, 'the row SURVIVES the resumed gen5 delivery — its compensating delete was REFUSED (the acked row cannot be compensated away from below; the exact R10-1/R11-6 loss class)').toBe(1);
    expect(rows[0]!.source_gen, 'the surviving row still carries the ADOPTING generation').toBe(6);

    // (4) The refusal witness at the declared API surface: compensating under
    // gen5 is refused BECAUSE the row was adopted (source_gen moved to 6).
    await expect(outbox.compensateAuditInsert('evt-adopt-1', 5)).resolves.toBe(false);
    expect((await rawAuditRows(dbName)).length, 'the refused compensation left the row in place').toBe(1);
  });

  test('compensation control (R11-6, rev 3): the SAME stale-generation re-check with NO adoption DOES compensate — the un-adopted row is deleted by the delivery flow, proving the main leg\'s refusal is caused by adoption, not by a no-op compensation (audit-outbox)', async () => {
    const prefix = nextPrefix();
    const outbox = await freshOutbox(prefix);
    const dbName = await auditDbName(prefix);
    const t0 = Date.now();
    const envelope = env('evt-comp-1', 'pack_remove', 'comp-pack@1.0.0', t0);

    // Same shape as the main leg, but NO gen6 redelivery ever happens: the
    // row stays source_gen = 5 when the stale delivery resumes.
    const queue = new MemoryOutboxQueue();
    queue.enqueue(envelope);
    let gen = 5;
    queue.currentGeneration = () => gen;
    const insertedSignal = makeGate();
    const pause = makeGate();
    const delivery = outbox.deliverPendingOutbox(
      queue,
      async (delivered: OutboxEnvelopeLike) => {
        const inserted = await outbox.appendAuditEnvelope(delivered, { generation: 5 });
        expect(inserted.inserted, 'the stale delivery created the row (arrange)').toBe(true);
        insertedSignal.open();
        await pause.promise;
      },
      { generation: 5 },
    );
    await insertedSignal.promise;
    expect((await rawAuditRows(dbName)).length, 'the un-adopted row exists while the delivery is paused').toBe(1);
    gen = 6; // stale — the binding moved, but NOTHING adopted the row
    pause.open();
    await delivery;
    expect(queue.ackedIds(), 'the stale delivery did NOT ack').toEqual([]);
    expect((await rawAuditRows(dbName)).length, 'the UN-ADOPTED stale row WAS compensated (deleted) — the post-commit re-check and the compensating delete really execute in the delivery flow, so the main leg\'s survival is the ADOPTION refusal, not a missing mechanism').toBe(0);
    await expect(outbox.compensateAuditInsert('evt-comp-1', 5)).resolves.toBe(false);
  });
});
