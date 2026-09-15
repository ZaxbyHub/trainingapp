/**
 * Unit tests for the D7 slide-doc resolver (issue #83).
 *
 * The resolver reads the keyword index's chunk mapping: chunk source filename
 * `docs/slide-<n>-<slideId>.json` + `[training-slide]` marker line. Pure
 * boundary mocks — the learn-kernel marker parsing runs for real.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockKeywordIndex = {
  isReady: vi.fn(),
  findChunks: vi.fn(),
};

vi.mock('../search/keyword-index', () => ({
  getKeywordIndex: vi.fn(() => mockKeywordIndex),
}));

import { resolveSlideDoc, MAX_SLIDE_TEXT_CHARS } from './slide-doc-resolver';

const MARKER_CHUNK = {
  docId: 'pack-doc-1',
  chunkIndex: 0,
  score: 1,
  source: 'docs/slide-3-ABC123.json',
  text: '[training-slide] section=Intro to CDP | title=Welcome | slide_id=ABC123\nThe welcome screen introduces the CDP home dashboard.',
};

describe('resolveSlideDoc (issue #83 D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeywordIndex.isReady.mockReturnValue(true);
  });

  test('resolves section + on-screen text from a marker chunk', () => {
    mockKeywordIndex.findChunks.mockReturnValue([MARKER_CHUNK]);
    const resolved = resolveSlideDoc('ABC123');
    expect(resolved).not.toBeNull();
    expect(resolved!.section).toBe('Intro to CDP');
    expect(resolved!.text).toBe('The welcome screen introduces the CDP home dashboard.');
  });

  test('strips the marker line from the injected text', () => {
    mockKeywordIndex.findChunks.mockReturnValue([MARKER_CHUNK]);
    const resolved = resolveSlideDoc('ABC123');
    expect(resolved!.text).not.toContain('[training-slide]');
    expect(resolved!.text).not.toContain('slide_id');
  });

  test('returns null when the index is not ready (degrade, never guess)', () => {
    mockKeywordIndex.isReady.mockReturnValue(false);
    expect(resolveSlideDoc('ABC123')).toBeNull();
    expect(mockKeywordIndex.findChunks).not.toHaveBeenCalled();
  });

  test('returns null when no chunk matches the slide id', () => {
    mockKeywordIndex.findChunks.mockReturnValue([]);
    expect(resolveSlideDoc('NOPE')).toBeNull();
  });

  test('returns null for an empty slide id', () => {
    expect(resolveSlideDoc('')).toBeNull();
    expect(mockKeywordIndex.findChunks).not.toHaveBeenCalled();
  });

  test('caps the injected text at MAX_SLIDE_TEXT_CHARS', () => {
    mockKeywordIndex.findChunks.mockReturnValue([
      {
        ...MARKER_CHUNK,
        text: `[training-slide] section=S | title=T | slide_id=ABC123\n${'x'.repeat(5000)}`,
      },
    ]);
    const resolved = resolveSlideDoc('ABC123');
    expect(resolved!.text!.length).toBe(MAX_SLIDE_TEXT_CHARS);
    expect(MAX_SLIDE_TEXT_CHARS).toBe(2000);
  });

  test('falls back to raw text for a marker-less chunk with a slide filename', () => {
    mockKeywordIndex.findChunks.mockReturnValue([
      { docId: 'd', chunkIndex: 2, score: 1, source: 'docs/slide-3-ABC123.json', text: 'continuation body text' },
    ]);
    const resolved = resolveSlideDoc('ABC123');
    expect(resolved).not.toBeNull();
    expect(resolved!.section).toBeUndefined();
    expect(resolved!.text).toBe('continuation body text');
  });
});
