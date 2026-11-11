// ingest/extractors.ts — Node-side document text extraction (issue #64, B6).
//
// Coverage parity with web_ui's browser extractor-factory (pdf/docx/xlsx/
// txt/md/pptx), reimplemented for plain Node: no File/Blob objects, no
// DOMParser, no worker scripts. Libraries are version-pinned to the same
// majors web_ui already ships (pdfjs-dist, mammoth, xlsx/SheetJS, jszip) so
// extraction behavior stays in the family the repo has tested.
// Issue #319: .xlsx no longer loads ANY library here — the workbook parse
// and its zip-bomb cap run in the xlsx-worker child process, never in the
// Electron main process. Issue #320: the same now holds for .docx / .pptx /
// .pdf — mammoth, JSZip, pdfjs-dist and the .docx/.pptx zip-bomb cap run in
// the doc-worker child process. Only the plain-text formats (.txt / .md) are
// still read in-process.
import fs from 'node:fs';
import path from 'node:path';
import { extractDocOutOfProcess } from './doc-worker.js';

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

// ---- .xlsx ------------------------------------------------------------------
// Issue #319 AC1: the workbook parse runs OUT OF PROCESS — extractors.ts must
// not import `xlsx` at all (frozen directory-wide pin). The SheetJS parse and
// the zip-bomb cap both execute inside the child (xlsx-worker-child.ts); this
// module only delegates. textExtractorOpts carries the runner options through
// extractDocumentFromFile's public surface.

// ---- .docx / .pptx / .pdf ---------------------------------------------------
// Issue #320 AC1/AC2: the document parses run OUT OF PROCESS — this module
// loads no mammoth / jszip / pdfjs-dist and reads no untrusted document byte.
// The mammoth, JSZip and pdfjs-dist parses AND the .docx/.pptx zip-bomb cap
// (the declared central-directory sum) execute inside the doc child
// (doc-worker-child.ts), launched by the doc runner (doc-worker.ts); this
// module only delegates and forwards the runner options.

/** Runner options the document routes forward to the out-of-process worker. */
interface DocRunnerOptions {
  maxZipBytes?: number;
  timeoutMs?: number;
  childPath?: string;
}

async function extractDocViaWorker(filePath: string, runnerOpts: DocRunnerOptions = {}): Promise<ExtractionResultNode> {
  const { text, pages } = await extractDocOutOfProcess(filePath, {
    ...(runnerOpts.maxZipBytes !== undefined ? { maxZipBytes: runnerOpts.maxZipBytes } : {}),
    ...(runnerOpts.timeoutMs !== undefined ? { timeoutMs: runnerOpts.timeoutMs } : {}),
    ...(runnerOpts.childPath !== undefined ? { childPath: runnerOpts.childPath } : {}),
  });
  return pages !== undefined ? { text, pages } : { text };
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

/** In-process extractors: plain-text formats only. */
const EXTRACTORS: Record<string, (filePath: string) => Promise<ExtractionResultNode>> = {
  '.txt': extractTextFile,
  '.md': extractTextFile,
};

/**
 * Extract text (and, when the format exposes it, per-page text) from a file.
 * Throws for unsupported extensions and for unreadable/corrupt sources —
 * the pipeline turns per-file errors into isolated failures. `.xlsx` (issue
 * #319) and `.docx` / `.pptx` / `.pdf` (issue #320) parse out of process:
 * timeoutMs and childPath forward to the matching runner for every one of
 * them, and maxZipBytes forwards to the child for the zip containers
 * (`.xlsx`, `.docx`, `.pptx`) — `.pdf` never receives a cap. No format is
 * capped in this process.
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
  if (extension === '.docx' || extension === '.pptx' || extension === '.pdf') {
    // The zip cap is meaningful only for the zip containers; .pdf never gets one.
    const isZipContainer = extension !== '.pdf';
    return extractDocViaWorker(filePath, {
      ...(isZipContainer && opts?.maxZipBytes !== undefined ? { maxZipBytes: opts.maxZipBytes } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.childPath !== undefined ? { childPath: opts.childPath } : {}),
    });
  }
  const extractor = extension ? EXTRACTORS[extension] : undefined;
  if (!extractor) {
    throw new Error(`Unsupported file extension: ${extension || '(none)'}`);
  }
  return extractor(filePath);
}
