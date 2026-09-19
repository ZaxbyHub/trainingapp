/**
 * citations.test.ts — C7 (issue #74): unit tests for the wire→UI citation
 * mapper. Lives OUTSIDE the quarantined ChatPage suites (the ChatPage page
 * tests are vitest-excluded, i.e. zero CI coverage) so the mapping contract
 * is CI-enforced: pack provenance fields must survive the mapping, and the
 * browser-RAG chunks path must keep excluding the retrieval-only score field
 * (PRR-008).
 */
import { describe, expect, it } from 'vitest';
import { citationsToRefs } from './citations';
import type { Citation } from './types';

describe('citationsToRefs (C7 pack provenance mapping)', () => {
  it('carries pack fields and source/page through, synthesizing pill keys', () => {
    const citations: Citation[] = [
      {
        source: 'docs/welcome.md',
        page: 3,
        pack_id: 'bundled-min',
        pack_version: '1.0.0',
        pack_published_at: '2026-09-16T00:00:00Z',
      },
    ];
    expect(citationsToRefs(citations)).toEqual([
      {
        docId: 'docs/welcome.md',
        chunkIndex: 0,
        source: 'docs/welcome.md',
        page: 3,
        packId: 'bundled-min',
        packVersion: '1.0.0',
        packPublishedAt: '2026-09-16T00:00:00Z',
      },
    ]);
  });

  it('maps nulls to undefined and keeps array order for pill [i+1]', () => {
    const refs = citationsToRefs([
      { source: '', page: null, pack_id: null, pack_version: null, pack_published_at: null },
      { source: 'b.md', page: null, pack_id: 'p2', pack_version: '2.0.0', pack_published_at: null },
    ]);
    expect(refs[0].docId).toBe('citation-1');
    expect(refs[0].source).toBeUndefined();
    expect(refs[0].page).toBeUndefined();
    expect(refs[0].packId).toBeUndefined();
    expect(refs[1].chunkIndex).toBe(1);
    expect(refs[1].packVersion).toBe('2.0.0');
  });
});
