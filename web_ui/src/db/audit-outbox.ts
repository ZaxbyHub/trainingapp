/** Acknowledged desktop audit outbox subscriber (#373 AC3). */
import { AUDIT_RETENTION_MS, auditDb, type AuditEventClass } from './audit';

export interface OutboxEnvelope {
  eventId: string;
  event: AuditEventClass;
  subject: string | null;
  occurredAt: number;
}

export type AuditSink = (envelope: OutboxEnvelope) => Promise<void>;

export interface OutboxQueue {
  pending(): Promise<OutboxEnvelope[]>;
  ack(eventId: string): Promise<void>;
  currentGeneration?(): number | Promise<number>;
}

/**
 * Commit point: transactional eventId dedup, monotonic generation adoption,
 * and source sequencing. A dedup hit never creates a second visible row.
 */
export async function appendAuditEnvelope(
  envelope: OutboxEnvelope,
  options?: { generation?: number; sourceSeq?: number | null },
): Promise<{ inserted: boolean }> {
  return auditDb.transaction('rw', auditDb.events, auditDb.meta, async () => {
    const cutoff = Date.now() - AUDIT_RETENTION_MS;
    await auditDb.events.where('ts').below(cutoff).delete();
    const existing = await auditDb.events.where('eventId').equals(envelope.eventId).first();
    if (existing !== undefined) {
      if (
        options?.generation !== undefined &&
        options.generation > (existing.source_gen ?? 0)
      ) {
        await auditDb.events.update(existing.seq!, { source_gen: options.generation });
      }
      return { inserted: false };
    }
    const seq = options?.sourceSeq ?? null;
    await auditDb.events.add({
      ts: envelope.occurredAt,
      event: envelope.event,
      subject: envelope.subject,
      eventId: envelope.eventId,
      source_seq: seq,
      ...(options?.generation === undefined ? {} : { source_gen: options.generation }),
    });
    if (seq !== null) {
      const prior = await auditDb.meta.get('source_seq_high');
      const previous = typeof prior?.value === 'number' ? prior.value : 0;
      if (seq > previous) await auditDb.meta.put({ key: 'source_seq_high', value: seq });
    }
    return { inserted: true };
  });
}

/** Atomic ownership-checked compensation for a stale delivery. */
export async function compensateAuditInsert(eventId: string, generation: number): Promise<boolean> {
  return auditDb.transaction('rw', auditDb.events, async () => {
    const row = await auditDb.events.where('eventId').equals(eventId).first();
    if (row === undefined || row.source_gen !== generation) return false;
    await auditDb.events.delete(row.seq!);
    return true;
  });
}

/** Deliver pending rows; ack only after commit and a matching generation. */
export async function deliverPendingOutbox(
  queue: OutboxQueue,
  sink: AuditSink = async (envelope) => { await appendAuditEnvelope(envelope); },
  options?: { generation?: number },
): Promise<void> {
  for (const envelope of await queue.pending()) {
    await sink(envelope);
    if (options?.generation !== undefined && queue.currentGeneration !== undefined) {
      const current = await queue.currentGeneration();
      if (current !== options.generation) {
        await compensateAuditInsert(envelope.eventId, options.generation);
        continue;
      }
    }
    await queue.ack(envelope.eventId);
  }
}
