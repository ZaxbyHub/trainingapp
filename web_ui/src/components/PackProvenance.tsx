/**
 * PackProvenance — issue #34 item 3: the aggregate in-chat pack-version
 * provenance indicator. Per-pill provenance (SourceCitation's
 * `— <packId> v<version>` suffix, C7) names the pack behind each citation
 * pill; this component aggregates the message's own persisted citations into
 * one answer-level line naming every contributing pack and its version, so a
 * reader can tell which corpus version grounded an answer without leaving
 * the chat. It derives purely from the persisted citations (stamped by the
 * citationsToRefs choke point and stored on ChatMessage), so it renders the
 * same on history reload, in the desktop app and in the browser app, and it
 * never consults the live pack registry — after a rollback the chip still
 * shows what actually grounded the answer, not the registry's current state.
 *
 * Version tolerance: a citation may carry packId without packVersion (the
 * repo's additive convention for older servers / pack-less attribution). Such
 * an entry renders the pack id alone; a version is never fabricated.
 */
import type { CitationRef } from '../types/chat';

/** One distinct contributing pack: id plus the version it was cited from (null = not carried). */
export interface PackProvenanceEntry {
  packId: string;
  version: string | null;
}

/**
 * Distinct (packId, version) pairs from the message's citations, in
 * first-appearance order. Dedup key is the PAIR, not the pack id — one pack
 * cited at two versions (post-rollback history) contributes two entries.
 */
export function packProvenance(citations: CitationRef[] | undefined): PackProvenanceEntry[] {
  const entries: PackProvenanceEntry[] = [];
  const seen = new Set<string>();
  for (const cite of citations ?? []) {
    if (cite.packId === undefined) continue;
    const key = `${cite.packId}\u0000${cite.packVersion ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ packId: cite.packId, version: cite.packVersion ?? null });
  }
  return entries;
}

function formatEntry(entry: PackProvenanceEntry): string {
  return entry.version === null ? entry.packId : `${entry.packId} v${entry.version}`;
}

/**
 * The aggregate provenance line. Renders nothing when no citation carries a
 * packId (messages grounded only in user-uploaded documents keep a
 * byte-identical surface).
 */
export function PackProvenance({ citations }: { citations?: CitationRef[] }) {
  const entries = packProvenance(citations);
  if (entries.length === 0) return null;
  const humanList = entries.map(formatEntry).join(', ');
  const label = `Grounded by knowledge pack(s): ${humanList}`;
  return (
    <div className="chat-pack-provenance" data-testid="pack-provenance" aria-label={label}>
      {label}
    </div>
  );
}
