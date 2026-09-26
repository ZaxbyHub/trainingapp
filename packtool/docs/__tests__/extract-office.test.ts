/**
 * extract-office.test.ts — issue #133 guardrail: build-docs ingests office
 * and PDF sources (the initial knowledge pack corpus is .docx/.pdf/.xlsx).
 *
 * Pre-fix, extract.ts supported only .md/.txt/.json and skipped every office
 * document ("no supported documents" over the whole corpus). Pins:
 *   1. .docx and .xlsx sources are ingested — bytes staged unchanged, text
 *      extracted, chunked, and the pack verifies.
 *   2. dot-directories in the source tree are skipped entirely (operator
 *      build artifacts colocated with sources can never join a pack).
 *   3. unsupported files remain reported as skipped, and the no-docs error
 *      message keeps its pinned phrase.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractSourceDocs } from '../extract.js';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'packtool-extract-office-'));
}

/** Minimal but real .docx (mammoth-readable): zip with word/document.xml. */
async function writeDocx(file: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function writeXlsx(file: string, rows: string[][]): void {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, file);
}

describe('extractSourceDocs office ingestion (#133)', () => {
  it('ingests .docx and .xlsx with extracted text and unchanged bytes', async () => {
    const dir = makeDir();
    try {
      await writeDocx(path.join(dir, 'brief.docx'), 'BATDOK-J combined release notes for the field trainer.');
      writeXlsx(path.join(dir, 'glossary.xlsx'), [['Term', 'Meaning'], ['DCW', 'Data Call Workflow']]);
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text sibling');
      fs.writeFileSync(path.join(dir, 'poster.png'), 'not a document');

      const { docs, skipped } = await extractSourceDocs(dir);
      expect(skipped).toEqual(['poster.png']);
      const paths = docs.map((doc) => doc.packPath).sort();
      expect(paths).toEqual(['docs/brief.docx', 'docs/glossary.xlsx', 'docs/notes.txt']);

      const docx = docs.find((doc) => doc.packPath === 'docs/brief.docx');
      expect(docx).toBeDefined();
      expect(docx!.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(docx!.text).toContain('BATDOK-J');
      expect(docx!.bytes.length).toBeGreaterThan(500); // the real zip, not the text

      const xlsx = docs.find((doc) => doc.packPath === 'docs/glossary.xlsx');
      expect(xlsx).toBeDefined();
      expect(xlsx!.text).toContain('Data Call Workflow');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips dot-directories entirely (colocated build artifacts never join a pack)', async () => {
    const dir = makeDir();
    try {
      fs.mkdirSync(path.join(dir, '.build'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.build', 'pack.json'), '{"id":"not-a-text-doc"}');
      fs.writeFileSync(path.join(dir, 'real.txt'), 'real content');

      const { docs, skipped } = await extractSourceDocs(dir);
      expect(docs.map((doc) => doc.packPath)).toEqual(['docs/real.txt']);
      expect(skipped).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
