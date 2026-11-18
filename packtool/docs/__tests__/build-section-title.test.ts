// frozen-check C4 — #360 AC1: deterministic section-title headers on slide
// chunks at pack build.
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f. The implementer must make this
// pass WITHOUT editing it; canonical copy dropped byte-identical at
// packtool/docs/__tests__/build-section-title.test.ts.
//
// FROZEN HEADER CONTRACT (the format decision the plan was allowed to make,
// pinned here as bytes — mirrors the UI path convention
// web_ui/src/lib/training/PinnedSlideContext.tsx `Section > Title` and the
// extractor provenance `<section> > Slide N`):
//   - EVERY chunk of a slide document is stored as:
//         `<section> > <slide_title>` + '\n' + <chunk body>
//     where <chunk body> is EXACTLY the output of the existing shared
//     chunker (build/chunk.ts chunkSlideText) over the slide's original
//     RAG text ([slide_title, on_screen_text, transcript_text] joined by
//     blank lines) — the original chunk text is UNCHANGED, the header is
//     the entire first line, and exactly one '\n' separates header from
//     body.
//   - Header part normalization (same philosophy as the runtime marker):
//     each whitespace run (including any newline) inside a section or
//     title collapses to ONE ASCII space; leading/trailing whitespace is
//     trimmed. Clean fixture values are unaffected.
//   - The `<unassigned>` section sentinel (extract.ts) passes through as
//     the literal section part: `<unassigned> > <title>`.
//   - The course-outline document's chunks carry NO header, and plain-doc
//     packs (docs/build-docs.ts) carry NO header.
//   - Identity stays self-consistent per the desktop install re-derivation
//     (desktop/main/backend/store/pack-manager.ts re-derives chunkId and
//     content_hash from stored text and refuses on mismatch): for every
//     chunk row, id === chunkIdFor(doc_id, chunk_index, normalizedText(text))
//     and content_hash === contentHashFor(normalizedText(text)), using the
//     EXISTING exported helpers (base surface, desktop-parity pinned, not
//     under change). Chunk identity must therefore be stable across two
//     identical builds (asserted byte-for-byte).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildStorylinePack } from '../../build/compose';
import { chunkSlideText, chunkIdFor, contentHashFor, normalizedText } from '../../build/chunk';
import { buildDocsPack } from '../build-docs';
import { makeSyntheticPublish } from '../../storyline/__tests__/helpers/build-fixture';
import { extractPackIndex } from '../../storyline/__tests__/helpers/extract-pack-index';

interface ChunkRow {
  path: string;
  docId: string;
  id: string;
  idx: number;
  text: string;
  hash: string;
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

function openPackIndex(indexPath: string): SqliteDb {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as new (p: string) => SqliteDb;
  const sqliteVec = require('sqlite-vec') as { load(db: unknown): void };
  const db = new Database(indexPath);
  sqliteVec.load(db);
  return db;
}

function chunkRowsOf(db: SqliteDb): ChunkRow[] {
  return db
    .prepare(
      'SELECT d.path AS path, d.id AS docId, c.id AS id, c.chunk_index AS idx, c.text AS text, c.content_hash AS hash ' +
        'FROM chunks c JOIN docs d ON d.id = c.doc_id ORDER BY d.path, c.chunk_index',
    )
    .all() as ChunkRow[];
}

/** Frozen header-part normalization: whitespace runs -> single space. */
function headerPart(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function headerLine(section: string, title: string): string {
  return `${headerPart(section)} > ${headerPart(title)}`;
}

/** The slide's ORIGINAL RAG text, rebuilt from the extractor's own doc JSON. */
function originalSlideText(doc: { slide_title?: string; on_screen_text?: string; transcript_text?: string }): string {
  return [doc.slide_title, doc.on_screen_text, doc.transcript_text]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

async function readDocJson(packPath: string, docPath: string): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(readFileSync(packPath));
  const entry = zip.file(docPath);
  if (entry === null) throw new Error(`pack has no ${docPath}`);
  return JSON.parse(await entry.async('string')) as Record<string, unknown>;
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newScratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

/** Assert the full frozen chunk contract for one slide document. */
function expectSlideChunks(rows: ChunkRow[], docPath: string, section: string, title: string, original: string): void {
  const expected = chunkSlideText(original);
  expect(
    rows.length,
    `${docPath}: chunk count must match the shared chunker over the original slide text`,
  ).toBe(expected.length);
  expect(expected.length, `${docPath}: fixture slide must produce at least one chunk`).toBeGreaterThan(0);
  const header = headerLine(section, title);
  const docId = rows[0]!.docId;
  for (let i = 0; i < expected.length; i += 1) {
    const row = rows[i]!;
    expect(row.idx, `${docPath} chunk ${i}: chunk_index`).toBe(i);
    expect(row.text, `${docPath} chunk ${i}: header first line + unchanged original chunk text`).toBe(
      `${header}\n${expected[i]!.text}`,
    );
    // Desktop-install self-consistency (pack-manager re-derivation).
    const normalized = normalizedText(row.text);
    expect(row.hash, `${docPath} chunk ${i}: content_hash must cover the stored text (header included)`).toBe(
      contentHashFor(normalized),
    );
    expect(row.id, `${docPath} chunk ${i}: chunk id must derive from the stored text (header included)`).toBe(
      chunkIdFor(docId, i, normalized),
    );
  }
}

describe('section-title headers on slide chunks (#360 AC1)', () => {
  it('storyline slide chunks carry the deterministic section-title header; outline chunks do not (section-title)', { timeout: 60_000 }, async () => {
    const root = newScratch('c4-syn-');
    const { publishDir, asrDir } = makeSyntheticPublish(root);
    const build = await buildStorylinePack({
      publishDir,
      asrDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'c4-section-title',
      version: '1.0.0',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(build.docs).toBe(4);

    const indexPath = await extractPackIndex(build.packPath, root);
    const db = openPackIndex(indexPath);
    try {
      const rows = chunkRowsOf(db);
      expect(rows.length).toBeGreaterThan(0);

      const byPath = (p: string) => rows.filter((row) => row.path === p);
      const s1Doc = (await readDocJson(build.packPath, 'docs/slide-001-S1.json')) as {
        slide_title: string; on_screen_text: string; transcript_text?: string; section_title: string;
      };
      const s2Doc = (await readDocJson(build.packPath, 'docs/slide-002-S2.json')) as typeof s1Doc;
      const s3Doc = (await readDocJson(build.packPath, 'docs/slide-003-S3.json')) as typeof s1Doc;

      // Fixture expectation: sections come from frame.js (Section One / Two).
      expect(s1Doc.section_title).toBe('Section One');
      expect(s2Doc.section_title).toBe('Section Two');
      expect(s3Doc.section_title).toBe('Section Two');

      expectSlideChunks(byPath('docs/slide-001-S1.json'), 'S1', s1Doc.section_title, s1Doc.slide_title, originalSlideText(s1Doc));
      expectSlideChunks(byPath('docs/slide-002-S2.json'), 'S2', s2Doc.section_title, s2Doc.slide_title, originalSlideText(s2Doc));
      expectSlideChunks(byPath('docs/slide-003-S3.json'), 'S3', s3Doc.section_title, s3Doc.slide_title, originalSlideText(s3Doc));

      // The outline document carries NO header (PC-10 exactness): every
      // outline chunk must be a SUBSTRING of the reconstructed outline body
      // — a prepended header line (any separator style) is not part of the
      // body and breaks containment. The body bytes mirror the frozen
      // outlineChunkText format (compose.ts:87-96) over the synthetic
      // fixture's meta (title 'OpMed CDP Synthetic' if absent → derive from
      // the outline doc JSON below rather than hardcoding drift).
      const outlineRows = byPath('docs/outline.json');
      expect(outlineRows.length).toBeGreaterThan(0);
      const outlineDoc = (await readDocJson(build.packPath, 'docs/outline.json')) as {
        title?: string; duration?: string; author?: string;
        sections?: Array<{ title: string; slide_count: number }>;
      };
      const outlineBody = [
        outlineDoc.title ?? '',
        `Duration: ${outlineDoc.duration}`,
        ...(outlineDoc.author !== undefined ? [`Author: ${outlineDoc.author}`] : []),
        'Course outline:',
        ...(outlineDoc.sections ?? []).map((s) => `- ${s.title} (${s.slide_count} slides)`),
      ].filter((line) => line.trim().length > 0).join('\n');
      // PC2-01 exactness: EXACT array equality against the shared chunker
      // over the reconstructed body — containment was both unsatisfiable-
      // tolerant (empty rows pass) and header-tolerant (a header inside a
      // body substring could slip). Nonempty expected chunks required.
      const expectedOutline = chunkSlideText(outlineBody);
      expect(expectedOutline.length, 'reconstructed outline must chunk nonempty').toBeGreaterThan(0);
      expect(outlineRows.length, 'outline chunk count must equal chunker output').toBe(expectedOutline.length);
      outlineRows.forEach((row, i) => {
        expect(row.text, `outline chunk ${i} must equal chunker output byte-for-byte (no header, no edit)`).toBe(expectedOutline[i]!.text);
      });
      const outlineJoined = outlineRows.map((row) => row.text).join('\n');
      expect(outlineJoined).toContain('Course outline:');
    } finally {
      db.close();
    }
  });

  it('newline-laden titles normalize to single spaces, unassigned slides keep the sentinel, and every chunk of a multi-chunk slide is headed (section-title)', { timeout: 60_000 }, async () => {
    const root = newScratch('c4-mini-');
    const publishDir = join(root, 'publish');
    mkdirSync(join(publishDir, 'html5', 'data', 'js'), { recursive: true });
    mkdirSync(join(publishDir, 'html5', 'lib'), { recursive: true });
    mkdirSync(join(publishDir, 'story_content'), { recursive: true });

    const provide = (name: string, payload: unknown): string =>
      `window.globalProvideData('${name}', '${JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');\n`;

    writeFileSync(
      join(publishDir, 'meta.xml'),
      '<?xml version="1.0" encoding="utf-8"?><meta title="C4 Mini" duration="1m" viewslides="3"><project id="c4mini" courseid="c4minicourse" /><author name="Mini Author" email="" website="" /></meta>\n',
      'utf8',
    );
    writeFileSync(join(publishDir, 'story.html'), '<!DOCTYPE html><html><body>mini</body></html>\n', 'utf8');
    writeFileSync(join(publishDir, 'html5', 'lib', 'loader.js'), '// mini loader\n', 'utf8');

    writeFileSync(
      join(publishDir, 'html5', 'data', 'js', 'data.js'),
      provide('data', {
        slideCount: 3,
        scenes: [
          { isMessageScene: true, kind: 'scene', sceneNumber: 0, slides: [{ id: 'MSG', title: 'Resume Prompt' }] },
          {
            isMessageScene: false,
            kind: 'scene',
            sceneNumber: 1,
            lmsId: 'SC1',
            startingSlide: 'S1',
            slides: [
              { id: 'S1', title: 'Multi\nLine  Title', lmsId: 'S1', html5url: 'html5/data/js/S1.js', slideNumberInScene: 1 },
              { id: 'S2', title: 'Lonely', lmsId: 'S2', html5url: 'html5/data/js/S2.js', slideNumberInScene: 2 },
              { id: 'S3', title: 'Wordy', lmsId: 'S3', html5url: 'html5/data/js/S3.js', slideNumberInScene: 3 },
            ],
          },
        ],
      }),
      'utf8',
    );
    // Outline covers S1 (newline-laden section) and S3 only — S2 stays
    // unassigned (extract.ts sentinel).
    writeFileSync(
      join(publishDir, 'html5', 'data', 'js', 'frame.js'),
      provide('frame', {
        navData: {
          outline: {
            links: [
              { displaytext: 'San\nSec', links: [{ slideid: '_player.sec1.S1' }] },
              { displaytext: 'WordSec', links: [{ slideid: '_player.sec3.S3' }] },
            ],
          },
        },
      }),
      'utf8',
    );

    const slidePayload = (altText: string, longText?: string): unknown => ({
      slideLayers: [
        {
          kind: 'layer',
          isBaseLayer: true,
          objects: [
            { kind: 'shape', id: 'shp', data: { vectorData: { altText } }, ...(longText === undefined ? {} : { textLib: [{ vartext: { blocks: [{ spans: [{ text: longText }] }] } }] }) },
          ],
        },
      ],
    });
    writeFileSync(join(publishDir, 'html5', 'data', 'js', 'S1.js'), provide('slide', slidePayload('Multi line body one.')), 'utf8');
    writeFileSync(join(publishDir, 'html5', 'data', 'js', 'S2.js'), provide('slide', slidePayload('Lonely slide body.')), 'utf8');
    // ~420 words of sentence-heavy text -> the shared chunker produces
    // MULTIPLE chunks for S3; every one of them must carry the header.
    const wordy = Array.from({ length: 60 }, (_, i) => `topic${i} covers detail${i} and note${i} plus remark${i} and aside${i} and figure${i} end of point.`).join(' ');
    writeFileSync(join(publishDir, 'html5', 'data', 'js', 'S3.js'), provide('slide', slidePayload('Wordy slide board.', wordy)), 'utf8');

    const build = await buildStorylinePack({
      publishDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'c4-mini',
      version: '1.0.0',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(build.docs).toBe(4);

    const indexPath = await extractPackIndex(build.packPath, root);
    const db = openPackIndex(indexPath);
    try {
      const rows = chunkRowsOf(db);
      const byPath = (p: string) => rows.filter((row) => row.path === p);

      const s1 = (await readDocJson(build.packPath, 'docs/slide-001-S1.json')) as { slide_title: string; on_screen_text: string; transcript_text?: string; section_title: string };
      const s2 = (await readDocJson(build.packPath, 'docs/slide-002-S2.json')) as typeof s1;
      const s3 = (await readDocJson(build.packPath, 'docs/slide-003-S3.json')) as typeof s1;
      expect(s2.section_title).toBe('<unassigned>');

      // Newline + multi-space normalization, pinned as bytes.
      expectSlideChunks(byPath('docs/slide-001-S1.json'), 'mini S1', s1.section_title, s1.slide_title, originalSlideText(s1));
      expect(
        byPath('docs/slide-001-S1.json')[0]!.text.split('\n')[0],
        'newline-laden section+title collapse to single spaces',
      ).toBe('San Sec > Multi Line Title');

      // Unassigned sentinel passes through as the literal section part.
      expectSlideChunks(byPath('docs/slide-002-S2.json'), 'mini S2', s2.section_title, s2.slide_title, originalSlideText(s2));
      expect(byPath('docs/slide-002-S2.json')[0]!.text.split('\n')[0]).toBe('<unassigned> > Lonely');

      // Multi-chunk slide: EVERY chunk is headed (>= 2 chunks here).
      const s3Rows = byPath('docs/slide-003-S3.json');
      expect(s3Rows.length, 'the wordy slide must produce multiple chunks').toBeGreaterThanOrEqual(2);
      expectSlideChunks(s3Rows, 'mini S3', s3.section_title, s3.slide_title, originalSlideText(s3));
    } finally {
      db.close();
    }
  });

  it('plain-doc packs (build-docs) carry NO section-title header (section-title)', { timeout: 60_000 }, async () => {
    const root = newScratch('c4-docs-');
    const sourceDir = join(root, 'src');
    mkdirSync(sourceDir, { recursive: true });
    const helloMd = '# Hello\n\nWorld text with no separators worth headering.\n';
    writeFileSync(join(sourceDir, 'hello.md'), helloMd, 'utf8');

    const build = await buildDocsPack({
      sourceDir,
      out: join(root, 'docs-pack.zip'),
      embedder: 'hash',
      id: 'c4-docs-nohdr',
      version: '1.0.0',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });

    const indexPath = await extractPackIndex(build.packPath, root);
    const db = openPackIndex(indexPath);
    try {
      const rows = chunkRowsOf(db);
      // PC2-01: the ESTABLISHED docs behavior is docChunkText(title + body)
      // (packtool/docs/build-docs.ts:75-85: title line prepended when the
      // body does not already start with it — markdownTitle 'Hello' is
      // prepended here because the body starts with '# '). Exact array
      // equality against the shared chunker over that reconstructed text.
      // (A naive substring-of-raw-md assertion is unsatisfiable for the
      // correct existing behavior — title prepend + sentence-joining — and
      // vacuous for empty chunks.)
      const expectedDocsText = helloMd.trimStart().startsWith('Hello') ? helloMd.trim() : `Hello\n\n${helloMd.trim()}`;
      const expected = chunkSlideText(expectedDocsText);
      expect(expected.length, 'docs source must chunk nonempty').toBeGreaterThan(0);
      expect(rows.length, 'docs-pack chunk count must equal chunker output').toBe(expected.length);
      rows.forEach((row, i) => {
        expect(row.text, `docs-pack chunk ${i} must equal chunker output byte-for-byte (no header of any kind)`).toBe(expected[i]!.text);
      });
    } finally {
      db.close();
    }
  });

  it('chunk identity is stable across two identical builds (section-title)', { timeout: 60_000 }, async () => {
    const root = newScratch('c4-det-');
    const { publishDir, asrDir } = makeSyntheticPublish(root);
    const options = {
      publishDir,
      asrDir,
      embedder: 'hash' as const,
      id: 'c4-det',
      version: '1.0.0',
      publishedAt: '2026-11-17T00:00:00.000Z',
    };
    const one = await buildStorylinePack({ ...options, out: join(root, 'one.zip') });
    const two = await buildStorylinePack({ ...options, out: join(root, 'two.zip') });

    // The existing determinism pattern: fully-fixed input, byte-identical zip.
    expect(readFileSync(one.packPath)).toEqual(readFileSync(two.packPath));

    // And directly: every chunk row (id, doc, index, text, hash) is identical
    // across builds — the desktop install re-derivation stays satisfied.
    const dbOne = openPackIndex(await extractPackIndex(one.packPath, root));
    const dbTwo = openPackIndex(await extractPackIndex(two.packPath, root));
    try {
      const rowsOne = chunkRowsOf(dbOne);
      const rowsTwo = chunkRowsOf(dbTwo);
      expect(rowsOne.length).toBeGreaterThan(0);
      expect(rowsOne).toEqual(rowsTwo);
      for (const row of rowsOne) {
        expect(row.id).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      dbOne.close();
      dbTwo.close();
    }
  });
});
