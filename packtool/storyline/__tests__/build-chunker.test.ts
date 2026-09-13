// Chunker parity + identity + doc-metadata tests (issue #79).
//
// PARITY GOLDEN DERIVATION (critic R2: pinned goldens, no cross-package
// import): the expected digests below were derived by running the DESKTOP
// implementation (desktop/main/backend/ingest/text-chunker.ts, unmodified)
// via Node 24 type-stripping over EXACTLY the inputs in CASES:
//
//   import { TextChunker } from 'file:///E:/ZCode/trainingapp-wt-79/desktop/main/backend/ingest/text-chunker.ts';
//   // chunk each CASES[name] with new TextChunker(256, 100).chunkText(text, name)
//   // digest = rows.map(r => ({len: r.text.length, sha256: sha256(r.text, 'utf8'), idx: r.chunkIndex}))
//
// If the desktop chunker ever changes semantics, this test fails — that is
// the drift alarm: re-derive the goldens and re-verify the pack layout
// deliberately, never silently.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TextChunker, chunkIdFor, docIdFor, normalizedText, contentHashFor } from '../../build/chunk';

const CASES: Record<string, string> = {
  short: 'Hydration checklist. Drink water at fixed intervals.',
  multiParagraph: [
    'Secure the splint with two straps. Check circulation below the injury site every hour.',
    '',
    'Elevate the limb above heart level. Dr. Smith recommends rechecking the wrap after 30 min, e.g. at 14:00 and 14:30.',
  ].join('\n\n'),
  longSingleSentence: `${Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')} end of sentence.`,
  cjkDense: '水分补充检查清单。按照固定的时间间隔饮水。每次训练后都要记录摄入量。',
  manyWords: Array.from({ length: 600 }, (_, i) => `chunk${i}`).join(' '),
};

// Derived from the desktop implementation over CASES (see derivation header).
const GOLDEN_DIGEST: Record<string, Array<{ len: number; sha256: string; idx: number }>> = {
  short: [{ len: 52, sha256: '7c2f3d3fcdc56f78d30b20fa85ddb941710fad523043804c839da88da55371c6', idx: 0 }],
  multiParagraph: [{ len: 202, sha256: '69056cd5f5854d8e9b364486d36bcac8699f3bcb53907565e79f9f8e7fdcee81', idx: 0 }],
  longSingleSentence: [
    { len: 1937, sha256: '1e3eddd0c54409400d7dc71fbff46a714b8d870474ab9f6581def6f3fd1b5baa', idx: 0 },
    { len: 768, sha256: 'bc5f6d00e1951287261e9485221153da650575eec563720e705b5b2348a7269a', idx: 1 },
  ],
  cjkDense: [{ len: 36, sha256: 'aa9decc78fb3c9c54d0ec34605a0df282cd7500e24c2e01b8c398f241759cf59', idx: 0 }],
  manyWords: [
    { len: 2193, sha256: '0e579ae6b7f5aad4a9ab3c3b435493c8aeb948a4ee8cc03ae5ae71a3e3fb4938', idx: 0 },
    { len: 2303, sha256: 'd1c9d2d1164acdef475cf69ab0848041088dbd7002a54f61358bf9b308c56ab2', idx: 1 },
    { len: 1691, sha256: '8c68677917f92341f8aaf2b6147cece16170ef37b5954545a5fb91e6e5a9feb0', idx: 2 },
  ],
};

const digest = (rows: Array<{ text: string; chunkIndex: number }>): Array<{ len: number; sha256: string; idx: number }> =>
  rows.map((row) => ({
    len: row.text.length,
    sha256: createHash('sha256').update(row.text, 'utf8').digest('hex'),
    idx: row.chunkIndex,
  }));

describe('build-chunker: parity with the desktop ingest chunker', () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`chunks "${name}" byte-identically to the desktop implementation`, () => {
      const rows = new TextChunker(256, 100).chunkText(text);
      expect(digest(rows)).toEqual(GOLDEN_DIGEST[name]);
    });
  }

  it('splits a long single sentence without spinning (F7)', () => {
    const rows = new TextChunker(256, 100).chunkText(CASES['longSingleSentence'] ?? '');
    expect(rows.length).toBe(2);
  });
});

describe('content-derived identity (pipeline.ts byte parity)', () => {
  it('normalizedText matches run_interop.py: CRLF->LF, trailing space strip', () => {
    expect(normalizedText('a\r\nb  \nc\t')).toBe('a\nb\nc');
  });

  it('docIdFor/chunkIdFor/contentHashFor use the pipeline formulas', () => {
    const docId = docIdFor(Buffer.from('document bytes'));
    expect(docId).toHaveLength(64);
    const normalized = normalizedText('chunk text ');
    const chunkId = chunkIdFor(docId, 3, normalized);
    expect(chunkId).toHaveLength(64);
    // Recompute by hand to pin the exact `${docId}:${index}:${normalized}` join.
    expect(chunkId).toBe(createHash('sha256').update(`${docId}:3:${normalized}`).digest('hex'));
    expect(contentHashFor(normalized)).toBe(createHash('sha256').update(normalized).digest('hex'));
  });
});
