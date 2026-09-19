/**
 * C7 (issue #74): wire→UI citation mapping.
 *
 * One choke point for converting the backend citation payloads into the UI's
 * CitationRef shape, so pack provenance fields cannot be silently dropped the
 * way they were at every ad-hoc rebuild site before this module existed (the
 * defect class the Phase 4.2 sweep guards).
 */
import type { Citation } from './types';
import type { CitationRef } from '../../types/chat';

/**
 * Map the contract's Citation[] (source/page/pack fields; no chunk text) into
 * renderable CitationRefs. docId/chunkIndex are synthesized from the array
 * position: the server citation array is the pill [i+1] order (the same
 * context-order contract the browser-RAG chunks path pins). Pack fields are
 * carried through verbatim so SourceCitation can render `<pack> v<version>`.
 */
export function citationsToRefs(citations: Citation[]): CitationRef[] {
  return citations.map((cite, index) => ({
    docId: cite.source || `citation-${index + 1}`,
    chunkIndex: index,
    source: cite.source || undefined,
    page: cite.page ?? undefined,
    packId: cite.pack_id ?? undefined,
    packVersion: cite.pack_version ?? undefined,
    packPublishedAt: cite.pack_published_at ?? undefined,
  }));
}
