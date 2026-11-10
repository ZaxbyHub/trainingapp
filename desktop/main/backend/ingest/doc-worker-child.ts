// doc-worker-child.ts — the document-parse CHILD (issue #320 AC1/AC2).
//
// This module is the ONLY place in desktop/main where an untrusted .docx,
// .pptx or .pdf is parsed. It runs as a separate OS process (an Electron
// utilityProcess in the packaged app, a node child_process.fork outside it),
// so a poisoned or hanging document can crash or wedge only this child —
// never the privileged main process that holds the store, the launch token
// and the filesystem. It mirrors xlsx-worker-child.ts (issue #319).
//
// The parse logic is moved byte-for-byte from the former in-process
// extractors.ts functions (extractDocxFile / extractPptxFile /
// extractPdfFile), so extracted text — and the per-page / per-slide `pages`
// the ingest pipeline feeds to the chunker — stays identical. The .pdf output
// is pinned by the committed golden (contracts/fixtures/pdf-parity/, frozen
// check i320-pdf-parity.test.ts); the .docx/.pptx output by the frozen C1 spec.
//
// The zip-bomb guard (declared central-directory sum) moved here too: the
// parent must not read ANY untrusted document byte, including the central
// directory the old parent-side assertZipWithinCap parsed.
//
// Report protocol (exactly one report over IPC, then exit):
//   { ok: true, text: string, pages?: {pageNumber, text}[] }
//   | { ok: false, error: string }
// Every failure error message carries the `doc worker: ` prefix. As for the
// xlsx child, the pin is REPORT-derivation: a rejection whose text arrives in
// a child REPORT is child-origin; parent-origin failures (launch refusal, no
// report, deadline) reuse the prefix for uniform display only.
//
// Loading rules (frozen C1 spec): no relative imports (Node's type-stripping
// `.ts` spawn fallback cannot rewrite `./x.js` specifiers) — only `node:`
// built-ins plus the three parser libraries, each through ONE dynamic
// import(). The runtime export surface is exactly DOC_WORKER_ERROR_PREFIX and
// runDocChildMain. This module stays electron-free; its self-run entry fires
// only when the module IS the process entry, exactly like xlsx-worker-child.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Failure messages are prefixed so the parent can prove child provenance. */
export const DOC_WORKER_ERROR_PREFIX = 'doc worker: ';

/** One extracted page (pdf page / pptx slide). */
interface ExtractionPage {
  pageNumber: number;
  text: string;
}

interface ExtractionResultNode {
  text: string;
  pages?: ExtractionPage[];
}

/** The single jszip load of this child (shared by the cap guard and .pptx). */
async function loadJsZip() {
  return (await import('jszip')).default;
}

/**
 * Extraction-bomb defense, moved verbatim from the parent (issue #320):
 * refuse zip-based documents whose entries DECLARE more decompressed bytes
 * than the cap. Reads only the central directory (JSZip decompresses entries
 * lazily). Sizes come from JSZip's internal _data metadata; an entry whose
 * size is unavailable is skipped from the sum (fail-open — the per-file input
 * cap still bounds it).
 */
async function assertZipWithinCap(filePath: string, capBytes: number): Promise<void> {
  const JSZip = await loadJsZip();
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
  const JSZip = await loadJsZip();
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

/**
 * pdfjs-dist decides "am I in Node?" ONCE, when its module is evaluated:
 * `!(process.versions.electron && process.type && process.type !== 'browser')`.
 * Before #320 the parse ran in the Electron MAIN process (process.type
 * 'browser'), under vitest and in a node fork (no process.type) — all
 * classified as Node. An Electron utility process reports process.type
 * 'utility', which pdfjs mis-classifies as a browser renderer: it then
 * demands GlobalWorkerOptions.workerSrc and takes its DOM code paths
 * (caught by the real-Electron harness, desktop/scripts/doc-electron-harness.mjs).
 * This child IS a Node process, so present it to pdfjs as one for the
 * duration of the parse (the module is first evaluated inside it) and
 * restore the original descriptor afterwards — the exact pre-migration code
 * path, so output stays byte-identical. A no-op outside a utility process.
 */
async function withPdfjsNodeEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'type');
  const masked =
    typeof process.versions.electron === 'string' &&
    original !== undefined &&
    original.configurable === true &&
    'value' in original &&
    original.value !== undefined &&
    original.value !== 'browser';
  if (masked) {
    Object.defineProperty(process, 'type', { ...original, value: 'browser' });
  }
  try {
    return await fn();
  } finally {
    if (masked) Object.defineProperty(process, 'type', original);
  }
}

/** Format by extension; the zip containers are the cap's scope. */
const EXTRACTORS: Record<string, (filePath: string) => Promise<ExtractionResultNode>> = {
  '.pdf': (filePath) => withPdfjsNodeEnvironment(() => extractPdfFile(filePath)),
  '.docx': extractDocxFile,
  '.pptx': extractPptxFile,
};
const ZIP_CONTAINERS: ReadonlySet<string> = new Set(['.docx', '.pptx']);

/** The utility-process parent port (Electron), when this is a utility process. */
function parentPort(): { postMessage(message: unknown): void } | null {
  const port = (process as unknown as { parentPort?: { postMessage(message: unknown): void } | null }).parentPort;
  return port !== undefined && port !== null && typeof port.postMessage === 'function' ? port : null;
}

/**
 * Deliver the ONE report over the IPC channel and resolve once it is handed
 * off: parentPort.postMessage writes synchronously into the Mojo pipe; Node's
 * process.send is asynchronous, so its callback gates the caller's exit.
 * With no IPC channel at all (a manual run) the report goes to stdout.
 */
function emit(report: Record<string, unknown>, channel?: { postMessage(message: unknown): void }): Promise<void> {
  if (channel !== undefined) {
    channel.postMessage(report);
    return Promise.resolve();
  }
  const port = parentPort();
  if (port !== null) {
    port.postMessage(report);
    return Promise.resolve();
  }
  if (typeof process.send === 'function') {
    return new Promise((resolve) => {
      process.send?.(report, undefined, undefined, () => resolve());
    });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return Promise.resolve();
}

/**
 * The child entry. argv shape (the #319 role rule, frozen by the C1 spec): the
 * document path is the LAST element, or the SECOND-TO-LAST when the last
 * element is a numeric zip cap. Returns the process exit code (0 success, 1
 * failure) after the report has been handed off.
 */
export async function runDocChildMain(
  argv: string[],
  channel?: { postMessage(message: unknown): void },
): Promise<number> {
  if (argv.length === 0) {
    await emit({ ok: false, error: `${DOC_WORKER_ERROR_PREFIX}no document path in argv` }, channel);
    return 1;
  }
  const last = argv[argv.length - 1] as string;
  const capForm = argv.length >= 2 && /^\d+$/.test(last);
  const filePath = capForm ? (argv[argv.length - 2] as string) : last;
  const maxZipBytes = capForm ? Number(last) : undefined;
  try {
    const extension = path.extname(filePath).toLowerCase();
    const extractor = EXTRACTORS[extension];
    if (extractor === undefined) {
      throw new Error(`${DOC_WORKER_ERROR_PREFIX}unsupported document extension: ${extension || '(none)'}`);
    }
    // The cap applies to the zip containers only; .pdf is never capped.
    if (maxZipBytes !== undefined && ZIP_CONTAINERS.has(extension)) {
      await assertZipWithinCap(filePath, maxZipBytes);
    }
    const result = await extractor(filePath);
    await emit(result.pages !== undefined ? { ok: true, text: result.text, pages: result.pages } : { ok: true, text: result.text }, channel);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefixed = message.startsWith(DOC_WORKER_ERROR_PREFIX) ? message : `${DOC_WORKER_ERROR_PREFIX}${message}`;
    await emit({ ok: false, error: prefixed }, channel);
    return 1;
  }
}

/**
 * Self-run ONLY as the process entry (importing this module from a spec — or
 * from its runner, which takes only the error prefix — must be
 * side-effect-free). Two entry shapes: an Electron utility process
 * (process.parentPort is present only there) or a forked node child (argv[1]
 * is this script) — the xlsx-worker-child / gpu-probe-child rule.
 */
function isProcessEntry(): boolean {
  if (parentPort() !== null) return true;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

/**
 * The argv handed to this child by the parent, minus this script's own entry:
 * a forked node child sees [execPath, thisScript, ...args]; an Electron
 * utility process may or may not carry the module path in argv.
 */
function childArgs(): string[] {
  let self: string;
  try {
    self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return process.argv.slice(1);
  }
  const idx = process.argv.findIndex((arg, i) => {
    if (i === 0) return false;
    try {
      return path.resolve(arg).toLowerCase() === self;
    } catch {
      return false;
    }
  });
  return idx >= 0 ? process.argv.slice(idx + 1) : process.argv.slice(1);
}

if (isProcessEntry()) {
  // Exit explicitly once the report is handed off: an Electron utility
  // process's parentPort keeps the event loop alive, and the parent settles
  // ON EXIT (the xlsx-worker-child rule).
  void runDocChildMain(childArgs())
    .then((code) => process.exit(code))
    .catch(async (err: unknown) => {
      await emit(
        { ok: false, error: `${DOC_WORKER_ERROR_PREFIX}child crashed: ${err instanceof Error ? err.message : String(err)}` },
      );
      process.exit(1);
    });
}
