// b6-supplementary.test.ts — supplementary (NON-frozen) B6 quality checks
// (issue #64, the critic-R2 commitments that live outside the acceptance
// specs so the frozen b6-*.test.ts files stay byte-stable):
//   - the pipeline enforces the embedder contract: vector width must equal
//     store dims and the vector count must equal the chunk count — a model
//     that contradicts either fails loud with a diagnostic instead of
//     corrupting the vec0 table;
//   - per-file failure isolation: one corrupt file never fails a directory
//     walk or a batch — it is reported, its siblings still land;
//   - CJK documents chunk by characters end-to-end and the text survives;
//   - the .docx/.pptx extractors run against real in-test fixtures (PDF is
//     exercised end-to-end by the bench driver — not duplicated; the .xlsx
//     fixture is present but SKIPPED pending the extractXlsxFile production
//     bug documented at the test);
//   - the first successful write records embedder.modelId into
//     meta.embedding_model_id.
//
// Requires desktop/node_modules (better-sqlite3, jszip, xlsx); CI has it.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { HashEmbedder, type EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
import { DEFAULT_INGEST_CONFIG } from '../../main/backend/ingest/config.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';
import { extractDocumentFromFile } from '../../main/backend/ingest/extractors.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function words(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function countRows(store: StoreHandle, table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Store + pipeline pair; the caller closes the store in its finally. */
function makePipeline(root: string, dims: number, embedder: EmbeddingSurface): { store: StoreHandle; pipeline: IngestPipeline } {
  const store = openStore({ dbPath: path.join(root, 'store.sqlite'), dims, repoRoot: REPO_ROOT });
  const pipeline = new IngestPipeline({ store, embedder, config: { ...DEFAULT_INGEST_CONFIG } });
  return { store, pipeline };
}

describe('b6 supplementary (critic R2): embedder contract enforcement', () => {
  itReal('an embedder wider than the store dims fails the file with the width diagnostic', async () => {
    const root = makeTempDir('b6s-dims-');
    const wide: EmbeddingSurface = {
      modelId: 'stub-wide',
      embed: async (texts) => texts.map(() => new Array<number>(8).fill(0.5)),
    };
    const { store, pipeline } = makePipeline(root, 4, wide);
    try {
      const res = await pipeline.ingestFile({
        name: path.join(root, 'x.txt'),
        data: Buffer.from(`${words(30, 'dim')} file\n`, 'utf8'),
      });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/width 8 does not match store dims 4/);
      // The rejected embed must not half-write: nothing reaches docs/chunks.
      expect(countRows(store, 'docs')).toBe(0);
      expect(countRows(store, 'chunks')).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('an embedder returning the wrong vector count fails with the count diagnostic', async () => {
    const root = makeTempDir('b6s-count-');
    const short: EmbeddingSurface = { modelId: 'stub-short', embed: async () => [] };
    const { store, pipeline } = makePipeline(root, 4, short);
    try {
      // 30 words chunk to exactly 1 chunk, so [] is one vector short.
      const res = await pipeline.ingestFile({
        name: path.join(root, 'y.txt'),
        data: Buffer.from(`${words(30, 'cnt')} file\n`, 'utf8'),
      });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/vectors for/);
      expect(countRows(store, 'docs')).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('b6 supplementary (critic R2): per-file failure isolation', () => {
  itReal('directory ingest: a corrupt .pdf fails alone; the good file still lands', async () => {
    const root = makeTempDir('b6s-dir-');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'good.txt'), `${words(60, 'good')} file\n`, 'utf8');
    fs.writeFileSync(path.join(docsDir, 'bad.pdf'), 'not a pdf', 'utf8');
    const { store, pipeline } = makePipeline(root, 8, new HashEmbedder({ dims: 8 }));
    try {
      const res = await pipeline.ingestDirectory(docsDir);
      expect(res.success).toBe(true);
      expect(res.documents).toBe(1);
      expect(typeof res.message).toBe('string');
      expect(res.message).toContain('bad.pdf');
      expect(countRows(store, 'docs')).toBe(1);
    } finally {
      store.close();
    }
  });

  itReal('batch ingest: the corrupt file is reported per-result; its sibling succeeds', async () => {
    const root = makeTempDir('b6s-batch-');
    const { store, pipeline } = makePipeline(root, 8, new HashEmbedder({ dims: 8 }));
    try {
      const res = await pipeline.ingestBatch([
        { name: 'good.txt', data: Buffer.from(`${words(60, 'batch')} file\n`, 'utf8') },
        { name: 'bad.pdf', data: Buffer.from('not a pdf', 'utf8') },
      ]);
      expect(res.total_files).toBe(2);
      expect(res.successful).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.results[1]?.success).toBe(false);
      expect(typeof res.results[1]?.error).toBe('string');
      expect((res.results[1]?.error ?? '').length).toBeGreaterThan(0);
      expect(res.results[0]?.success).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('b6 supplementary (critic R2): CJK end-to-end through the pipeline', () => {
  itReal('a 600-character CJK document chunks by characters and the text survives', async () => {
    const root = makeTempDir('b6s-cjk-');
    const { store, pipeline } = makePipeline(root, 8, new HashEmbedder({ dims: 8 }));
    try {
      const content = '文'.repeat(300) + '測'.repeat(300);
      const res = await pipeline.ingestFile({
        name: path.join(root, 'cjk.txt'),
        data: Buffer.from(content, 'utf8'),
      });
      expect(res.success).toBe(true);
      // CJK-dense text falls back to character-sized chunks (256 chars), so
      // 600 characters must span more than one chunk.
      expect(res.chunks_added).toBeGreaterThanOrEqual(2);
      const rows = store.db
        .prepare('SELECT chunk_index, text FROM chunks ORDER BY chunk_index')
        .all() as Array<{ chunk_index: number; text: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const joined = rows.map((row) => row.text).join('');
      for (const row of rows) {
        // Each chunk is an exact slice of the source — no mojibake, no lossy
        // transliteration anywhere in the round trip.
        expect(content).toContain(row.text);
      }
      expect(joined).toContain('文');
      expect(joined).toContain('測');
    } finally {
      store.close();
    }
  });
});

describe('b6 supplementary (critic R2): Office extractor fixtures (real bytes)', () => {
  itReal('a minimal in-test .docx extracts its text run', async () => {
    const root = makeTempDir('b6s-docx-');
    const zip = new JSZip();
    // Real wordprocessingml namespace URI: mammoth maps namespace URIs to
    // prefixes (office-xml-reader xmlNamespaceMap), so a placeholder URI is
    // not a docx — the fixture must carry the URI Word itself writes.
    zip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>Hello DOCX fixture</w:t></w:r></w:p></w:body></w:document>',
    );
    const docxPath = path.join(root, 'fixture.docx');
    fs.writeFileSync(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const extracted = await extractDocumentFromFile(docxPath);
    expect(extracted.text).toContain('Hello DOCX fixture');
  });

  // History: this fixture originally caught extractXlsxFile calling
  // workbook.utils.sheet_to_csv (SheetJS keeps `utils` on the module) —
  // the production call is fixed to XLSX.utils.sheet_to_csv; this test pins it.
  itReal('a minimal .xlsx written via the xlsx package extracts its cell text', async () => {
    const root = makeTempDir('b6s-xlsx-');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['B6 XLSX fixture']]), 'Sheet1');
    const xlsxPath = path.join(root, 'fixture.xlsx');
    fs.writeFileSync(xlsxPath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer);
    const extracted = await extractDocumentFromFile(xlsxPath);
    expect(extracted.text).toContain('B6 XLSX fixture');
  });

  itReal('a minimal in-test .pptx extracts its slide run', async () => {
    const root = makeTempDir('b6s-pptx-');
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:p><a:r><a:t>B6 PPTX fixture text</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>',
    );
    const pptxPath = path.join(root, 'fixture.pptx');
    fs.writeFileSync(pptxPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const extracted = await extractDocumentFromFile(pptxPath);
    expect(extracted.text).toContain('B6 PPTX fixture text');
  });
  // PDF extraction is covered end-to-end by the bench driver (and by the
  // corrupt-pdf isolation tests above), so no PDF fixture is built here.
});

describe('b6 supplementary (critic R2): meta bookkeeping', () => {
  itReal('the first successful write records the embedder id in meta.embedding_model_id', async () => {
    const root = makeTempDir('b6s-meta-');
    const { store, pipeline } = makePipeline(root, 8, new HashEmbedder({ dims: 8 }));
    try {
      const filePath = path.join(root, 'meta.txt');
      fs.writeFileSync(filePath, `${words(80, 'meta')} file\n`, 'utf8');
      const res = await pipeline.ingestFile({ name: filePath, data: fs.readFileSync(filePath) });
      expect(res.success).toBe(true);
      const row = store.db
        .prepare("SELECT value FROM meta WHERE key = 'embedding_model_id'")
        .get() as { value: string };
      expect(row.value).toBe('hash');
    } finally {
      store.close();
    }
  });
});
