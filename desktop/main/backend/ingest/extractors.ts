// ingest/extractors.ts — Node-side document text extraction (issue #64, B6).
//
// Coverage parity with web_ui's browser extractor-factory (pdf/docx/xlsx/
// txt/md/pptx), reimplemented for plain Node: no File/Blob objects, no
// DOMParser, no worker scripts. Libraries are version-pinned to the same
// majors web_ui already ships (pdfjs-dist, mammoth, xlsx/SheetJS, jszip) so
// extraction behavior stays in the family the repo has tested. Heavy
// libraries load lazily per type — ingesting .txt never pulls pdf.js.
import fs from 'node:fs';
import path from 'node:path';

/** One extracted page (currently PDF-only; page attribution feeds F8). */
export interface ExtractionPage {
  pageNumber: number;
  text: string;
}

export interface ExtractionResultNode {
  text: string;
  pages?: ExtractionPage[];
}

/** Extensions the pipeline ingests; everything else is skipped. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze([
  '.pdf',
  '.docx',
  '.xlsx',
  '.txt',
  '.md',
  '.pptx',
]);

export function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(filePath));
}

// ---- .txt / .md -------------------------------------------------------------

async function extractTextFile(filePath: string): Promise<ExtractionResultNode> {
  return { text: fs.readFileSync(filePath, 'utf8') };
}

// ---- .pdf -------------------------------------------------------------------
// pdfjs-dist ships a Node-safe legacy build; the default browser build assumes
// DOM + worker plumbing that does not exist here.

interface PdfTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}

async function extractPdfFile(filePath: string): Promise<ExtractionResultNode> {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(src: {
      data: Uint8Array;
      useSystemFonts: boolean;
      disableFontFace: boolean;
      isEvalSupported: boolean;
      useWorkerFetch: boolean;
    }): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: PdfTextItem[] }>;
        }>;
        destroy(): Promise<void>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  const pages: ExtractionPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // Reconstruct line breaks from item EOL markers; join fragments of the
      // same line with spaces (mirrors the browser extractor's text flow).
      let pageText = '';
      for (const item of content.items) {
        const str = typeof item.str === 'string' ? item.str : '';
        if (str.length === 0) continue;
        pageText += str;
        if (item.hasEOL) pageText += '\n';
        else pageText += ' ';
      }
      pages.push({ pageNumber, text: pageText.trim() });
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return { text: pages.map((p) => p.text).join('\n\n'), pages };
}

// ---- .docx ------------------------------------------------------------------

async function extractDocxFile(filePath: string): Promise<ExtractionResultNode> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });
  return { text: value };
}

// ---- .xlsx ------------------------------------------------------------------

async function extractXlsxFile(filePath: string): Promise<ExtractionResultNode> {
  const XLSX = (await import('xlsx')) as unknown as {
    read(data: Buffer, opts: { type: 'buffer' }): {
      SheetNames: string[];
      Sheets: Record<string, unknown>;
    };
    utils: { sheet_to_csv(sheet: unknown): string };
  };
  const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    if (csv.trim().length > 0) parts.push(csv.trim());
  }
  return { text: parts.join('\n\n') };
}

// ---- .pptx ------------------------------------------------------------------
// PPTX is a zip of slide XMLs; each text run lives in an <a:t> element. The
// browser extractor uses DOMParser; Node gets the same text via tag-scoped
// extraction over the sorted slide parts (regex over the slide's XML — slide
// XML is machine-generated with predictable <a:t> blocks).

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

async function extractPptxFile(filePath: string): Promise<ExtractionResultNode> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const num = (s: string): number => Number(/slide(\d+)\.xml$/.exec(s)?.[1] ?? 0);
      return num(a) - num(b);
    });
  const pages: ExtractionPage[] = [];
  for (let i = 0; i < slideNames.length; i += 1) {
    const slideName = slideNames[i];
    if (slideName === undefined) break;
    const slideEntry = zip.files[slideName];
    if (slideEntry === undefined) continue;
    const xml = await slideEntry.async('string');
    const runs: string[] = [];
    for (const match of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
      const decoded = decodeXmlEntities(match[1] ?? '');
      if (decoded.trim().length > 0) runs.push(decoded);
    }
    pages.push({ pageNumber: i + 1, text: runs.join('\n').trim() });
  }
  return { text: pages.map((p) => p.text).join('\n\n'), pages };
}

const EXTRACTORS: Record<string, (filePath: string) => Promise<ExtractionResultNode>> = {
  '.pdf': extractPdfFile,
  '.docx': extractDocxFile,
  '.xlsx': extractXlsxFile,
  '.txt': extractTextFile,
  '.md': extractTextFile,
  '.pptx': extractPptxFile,
};

/**
 * Extract text (and, when the format exposes it, per-page text) from a file.
 * Throws for unsupported extensions and for unreadable/corrupt sources —
 * the pipeline turns per-file errors into isolated failures.
 */
export async function extractDocumentFromFile(filePath: string): Promise<ExtractionResultNode> {
  const extension = extensionOf(filePath);
  const extractor = extension ? EXTRACTORS[extension] : undefined;
  if (!extractor) {
    throw new Error(`Unsupported file extension: ${extension || '(none)'}`);
  }
  return extractor(filePath);
}
