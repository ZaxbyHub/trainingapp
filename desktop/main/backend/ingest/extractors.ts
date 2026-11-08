// ingest/extractors.ts — Node-side document text extraction (issue #64, B6).
//
// Coverage parity with web_ui's browser extractor-factory (pdf/docx/xlsx/
// txt/md/pptx), reimplemented for plain Node: no File/Blob objects, no
// DOMParser, no worker scripts. Libraries are version-pinned to the same
// majors web_ui already ships (pdfjs-dist, mammoth, xlsx/SheetJS, jszip) so
// extraction behavior stays in the family the repo has tested. Heavy
// libraries load lazily per type — ingesting .txt never pulls pdf.js.
// Issue #319: .xlsx no longer loads ANY library here — the workbook parse
// and its zip-bomb cap run in the xlsx-worker child process, never in the
// Electron main process.
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
// Issue #319 AC1: the workbook parse runs OUT OF PROCESS — extractors.ts must
// not import `xlsx` at all (frozen directory-wide pin). The SheetJS parse and
// the zip-bomb cap both execute inside the child (xlsx-worker-child.ts); this
// module only delegates. textExtractorOpts carries the runner options through
// extractDocumentFromFile's public surface.

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

/** Runner options the .xlsx route forwards to the out-of-process worker. */
interface XlsxRunnerOptions {
  maxZipBytes?: number;
  timeoutMs?: number;
  childPath?: string;
}

async function extractXlsxViaWorker(filePath: string, runnerOpts: XlsxRunnerOptions = {}): Promise<ExtractionResultNode> {
  const { extractXlsxOutOfProcess } = await import('./xlsx-worker.js');
  const { text } = await extractXlsxOutOfProcess(filePath, {
    ...(runnerOpts.maxZipBytes !== undefined ? { maxZipBytes: runnerOpts.maxZipBytes } : {}),
    ...(runnerOpts.timeoutMs !== undefined ? { timeoutMs: runnerOpts.timeoutMs } : {}),
    ...(runnerOpts.childPath !== undefined ? { childPath: runnerOpts.childPath } : {}),
  });
  return { text };
}

const EXTRACTORS: Record<string, (filePath: string) => Promise<ExtractionResultNode>> = {
  '.pdf': extractPdfFile,
  '.docx': extractDocxFile,
  '.txt': extractTextFile,
  '.md': extractTextFile,
  '.pptx': extractPptxFile,
};

/**
 * Zip containers whose declared decompressed size the PARENT-side cap guard
 * sums. `.xlsx` is deliberately absent (issue #319 F4): its zip-bomb cap runs
 * INSIDE the parse child, so the main process never reads untrusted workbook
 * bytes at all.
 */
const ZIP_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pptx']);

/**
 * Extraction-bomb defense: refuse zip-based documents whose entries DECLARE
 * more decompressed bytes than the cap. Reads only the central directory
 * (JSZip decompresses entries lazily). Sizes come from JSZip's internal
 * _data metadata; an entry whose size is unavailable is skipped from the sum
 * (fail-open — the per-file input cap still bounds it).
 */
async function assertZipWithinCap(filePath: string, capBytes: number): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  let declared = 0;
  zip.forEach((_relativePath, entry) => {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size === 'number') declared += size;
  });
  if (declared > capBytes) {
    throw new Error(
      `zip content declares ${declared} decompressed bytes, exceeding the ${capBytes}-byte extraction cap; refusing`,
    );
  }
}

/**
 * Extract text (and, when the format exposes it, per-page text) from a file.
 * Throws for unsupported extensions and for unreadable/corrupt sources —
 * the pipeline turns per-file errors into isolated failures. For `.xlsx` the
 * parse (and the zip-bomb cap) run out of process (issue #319): timeoutMs and
 * childPath forward to the worker runner; maxZipBytes is forwarded to the
 * child too. For every other format opts.maxZipBytes keeps its in-process
 * central-directory guard for the zip containers that remain here.
 */
export async function extractDocumentFromFile(
  filePath: string,
  opts?: { maxZipBytes?: number; timeoutMs?: number; childPath?: string },
): Promise<ExtractionResultNode> {
  const extension = extensionOf(filePath);
  if (extension === '.xlsx') {
    return extractXlsxViaWorker(filePath, {
      ...(opts?.maxZipBytes !== undefined ? { maxZipBytes: opts.maxZipBytes } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.childPath !== undefined ? { childPath: opts.childPath } : {}),
    });
  }
  const extractor = extension ? EXTRACTORS[extension] : undefined;
  if (!extractor) {
    throw new Error(`Unsupported file extension: ${extension || '(none)'}`);
  }
  if (opts?.maxZipBytes !== undefined && ZIP_EXTENSIONS.has(extension)) {
    await assertZipWithinCap(filePath, opts.maxZipBytes);
  }
  return extractor(filePath);
}
