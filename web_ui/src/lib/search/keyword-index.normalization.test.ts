// keyword-index.normalization.test.ts — E-AC3 (issue #281): the browser
// keyword index finds a soft-hyphen / zero-width-space chunk by the plain
// ASCII search. Uses the REAL FlexSearch (the behavior under test is the
// index's tokenization against normalized stored text); the IndexedDB
// singleton surface is stubbed as a no-op because this spec drives the live
// index directly (addDocument + rebuildFromEntries = the two add sites) plus
// the search wrapper. The save-and-reload leg drives rebuildFromEntries with
// RAW persisted entries (what IndexedDB holds) and asserts the reload
// re-normalizes (critic r1: the reload writer had no discriminating leg).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeywordIndex } from './keyword-index';

vi.stubGlobal('indexedDB', {
  open: vi.fn().mockImplementation(() => ({
    onsuccess: null,
    onerror: null,
    result: {
      objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
      close: vi.fn(),
      transaction: vi.fn().mockReturnValue({
        objectStore: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ onsuccess: null }),
          put: vi.fn().mockReturnValue({ onsuccess: null }),
        }),
        oncomplete: null,
        onerror: null,
      }),
    },
  })),
});

const SOFT = String.fromCharCode(0x00ad);
const ZWSP = String.fromCharCode(0x200b);

type KeywordIndexTestAccess = { instance: KeywordIndex | null };
const KeywordIndexInternals = KeywordIndex as unknown as KeywordIndexTestAccess;

interface EntryLike {
  id: string;
  docId: string;
  chunkIndex: number;
  text: string;
  source?: string;
  page?: number;
}

describe('keyword index normalization (issue #281 E-AC3)', () => {
  beforeEach(() => {
    KeywordIndexInternals.instance = null;
  });

  afterEach(() => {
    KeywordIndexInternals.instance?.dispose();
    KeywordIndexInternals.instance = null;
    vi.restoreAllMocks();
  });

  /** Arm the singleton with a REAL FlexSearch index, bypassing the IndexedDB
   * load (the stubbed IDB request never fires onsuccess). This drives the
   * production createFlexIndex config + both add sites + the search wrapper. */
  function armedIndex(): KeywordIndex {
    const index = KeywordIndex.getInstance();
    const internals = index as unknown as {
      ready: boolean;
      index: unknown;
      createFlexIndex(): unknown;
      rebuildFromEntries(entries: EntryLike[]): void;
    };
    internals.index = internals.createFlexIndex();
    internals.ready = true;
    return index;
  }

  it('a soft-hyphen and a ZWSP chunk answer the plain ASCII search (add site)', () => {
    const index = armedIndex();
    index.addDocument('doc-soft', 0, `ef${SOFT}ficacy note`);
    index.addDocument('doc-zwsp', 0, `he${ZWSP}moglobin note`);
    index.addDocument('doc-plain', 0, 'plain protocol text');

    const effHits = index.search('efficacy', { limit: 10 });
    expect(effHits.map((r) => r.docId)).toContain('doc-soft');
    const hemoHits = index.search('hemoglobin', { limit: 10 });
    expect(hemoHits.map((r) => r.docId)).toContain('doc-zwsp');
    // The plain chunk is untouched by the change.
    const plainHits = index.search('protocol', { limit: 10 });
    expect(plainHits.map((r) => r.docId)).toContain('doc-plain');
  });

  it('rebuildFromEntries re-normalizes RAW persisted entries on load (reload site)', () => {
    const index = armedIndex();
    // Simulate what IndexedDB persists and what a fresh load replays: RAW
    // variant text entries going through the rebuild add site.
    const rawEntries: EntryLike[] = [
      { id: 'doc-soft:0', docId: 'doc-soft', chunkIndex: 0, text: `ef${SOFT}ficacy note` },
      { id: 'doc-zwsp:0', docId: 'doc-zwsp', chunkIndex: 0, text: `he${ZWSP}moglobin note` },
    ];
    const internals = index as unknown as { rebuildFromEntries(entries: EntryLike[]): void };
    internals.rebuildFromEntries(rawEntries);
    const effHits = index.search('efficacy', { limit: 10 });
    expect(effHits.map((r) => r.docId)).toContain('doc-soft');
    const hemoHits = index.search('hemoglobin', { limit: 10 });
    expect(hemoHits.map((r) => r.docId)).toContain('doc-zwsp');
  });

  it('the search wrapper normalizes the query (variant query, plain chunk)', () => {
    const index = armedIndex();
    index.addDocument('doc-plain2', 0, 'efficacy protocol text');
    const hits = index.search(`ef${SOFT}ficacy`, { limit: 10 });
    expect(hits.map((r) => r.docId)).toContain('doc-plain2');
  });

  it('the browser twin matches every vector in the shared contract file', async () => {
    const { normalizeForSearch } = await import('./normalize');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // web_ui/src/lib/search/ -> repo root is four levels up.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const corpus = JSON.parse(
      readFileSync(path.join(repoRoot, 'contracts', 'text-normalization-vectors.json'), 'utf8'),
    ) as { version: number; vectors: Array<{ id: string; input: string; expected: string }> };
    expect(corpus.version).toBe(1);
    for (const v of corpus.vectors) {
      expect(normalizeForSearch(v.input), `vector ${v.id}`).toBe(v.expected);
    }
  });
});
