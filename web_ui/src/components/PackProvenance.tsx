/**
 * PackProvenance — issue #34 item 3: the aggregate in-chat pack-version
 * provenance indicator. Per-pill provenance (SourceCitation's
 * `— <packId> v<version>` suffix, C7) names the pack behind each citation
 * pill; this component aggregates the message's own persisted citations into
 * one answer-level line naming every contributing pack version and its
 * version, so a reader can tell which corpus version(s) grounded an answer
 * without leaving the chat. It derives purely from the persisted citations
 * (stamped by the citationsToRefs choke point on the desktop wire and
 * forwarded from the fused retrieval results on the browser path, PRR-001
 * fix), so it renders the same on history reload, in the desktop app and in
 * the browser app, and it never consults the live pack registry — after a
 * rollback the chip still shows what actually grounded the answer, not the
 * registry's current state.
 *
 * Tolerance rules:
 * - A citation may carry packId without packVersion (additive convention for
 *   older servers / pre-existing indexes). Such an entry renders the pack id
 *   alone; a version is never fabricated.
 * - Falsy (empty-string) ids/versions are treated exactly like absent ones —
 *   an empty-string version never renders a dangling "v" token and an
 *   empty-string pack id never produces an empty entry (PRR-003 fix; same
 *   truthiness guard the per-pill surface applies).
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
 * cited at two versions (the engineered both-active state) contributes two
 * entries. Empty-string fields normalize to absent before dedup so undefined
 * and '' cannot collide into order-dependent output (PRR-003 fix).
 */
export function packProvenance(citations: CitationRef[] | undefined): PackProvenanceEntry[] {
  const entries: PackProvenanceEntry[] = [];
  const seen = new Set<string>();
  for (const cite of citations ?? []) {
    if (!cite.packId) continue;
    const version = cite.packVersion || null;
    const key = `${cite.packId}\u0000${version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ packId: cite.packId, version });
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
 *
 * No aria-label: the visible text IS the accessible name — aria-label on a
 * role-less div is a naming-prohibited attribute (ARIA 1.2 generic role) and
 * would duplicate the text in the AX tree (PRR-002 fix; GroundingBadge
 * precedent).
 */
export function PackProvenance({ citations }: { citations?: CitationRef[] }) {
  const entries = packProvenance(citations);
  if (entries.length === 0) return null;
  const humanList = entries.map(formatEntry).join(', ');
  const label = `Grounded by knowledge pack(s): ${humanList}`;
  return (
    <div className="chat-pack-provenance" data-testid="pack-provenance">
      {label}
    </div>
  );
}
