// docs/extract.ts — plain-document source extraction for build-docs (issue #73;
// office/PDF ingestion added for issue #133).
//
// Turns a folder of ordinary documents (.md, .txt, .json, .docx, .pdf, .xlsx)
// into the doc-build inputs the shared build pipeline
// (chunker/embedder/index-writer) consumes: one SourceDoc per supported file,
// in deterministic lexicographic order of the forward-slash path relative to
// the source root. Non-regular entries (symlinks/junctions) are REFUSED — the
// same stance as build-storyline's copyTreeRejectingLinks — and unsupported
// extensions are skipped with a reported note so a source folder containing
// stray non-docs still builds predictably (a build that silently embedded
// everything would be the surprise, not one that lists what it ignored).
// Dot-directories are skipped by the walk so operator-local build artifacts
// colocated with the sources (e.g. anything under knowledgepack/) can never
// leak into a pack.
//
// Office/PDF text extraction mirrors the desktop runtime's extractor
// (desktop/main/backend/ingest/extractors.ts) on the SAME pinned libraries
// (mammoth / pdfjs-dist legacy build / SheetJS) so pack-build text matches
// what a runtime re-extraction would produce. Original source BYTES are
// staged into the pack unchanged; only the text layer is derived here.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface SourceDoc {
  /** Pack-relative doc path: docs/<posix relative source path>. */
  packPath: string;
  /** Absolute source path (staging reads the same bytes we hashed). */
  sourcePath: string;
  bytes: Buffer;
  title: string;
  text: string;
  mime: string;
}

export interface ExtractResult {
  docs: SourceDoc[];
  /** Unsupported files present in the tree (reported by the caller). */
  skipped: string[];
}

/** The C1 bundled-docs convention: { "title": string, "text": string }. */
interface JsonDocShape {
  title?: unknown;
  text?: unknown;
}

const SUPPORTED: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Extensions whose TEXT is derived by an async office/PDF extractor
 * (issue #133); the plain-text family reads bytes directly. */
const ASYNC_TEXT_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx']);

/** First markdown H1 (`# Title`) in the text, or undefined. */
function markdownTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null && match[1] !== undefined && match[1].length > 0) return match[1];
  }
  return undefined;
}

function stem(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return base.length > 0 ? base : name;
}

// ---- office/PDF text extraction (desktop extractors are the reference) -----

async function extractDocxText(bytes: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return value;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  // pdfjs-dist ships a Node-safe legacy build; the default browser build
  // assumes DOM + worker plumbing that does not exist here.
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
        getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
        destroy(): Promise<void>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // Reconstruct line breaks from item EOL markers; join fragments of the
      // same line with spaces (mirrors the desktop extractor's text flow).
      let pageText = '';
      for (const item of content.items) {
        const str = typeof item.str === 'string' ? item.str : '';
        if (str.length === 0) continue;
        pageText += str;
        if (item.hasEOL) pageText += '\n';
        else pageText += ' ';
      }
      pages.push(pageText.trim());
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return pages.join('\n\n');
}

async function extractXlsxText(bytes: Buffer): Promise<string> {
  const XLSX = (await import('xlsx')) as unknown as {
    read(data: Buffer, opts: { type: 'buffer' }): {
      SheetNames: string[];
      Sheets: Record<string, unknown>;
    };
    utils: { sheet_to_csv(sheet: unknown): string };
  };
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    if (csv.trim().length > 0) parts.push(csv.trim());
  }
  return parts.join('\n\n');
}

const ASYNC_EXTRACTORS: Record<string, (bytes: Buffer) => Promise<string>> = {
  '.docx': extractDocxText,
  '.pdf': extractPdfText,
  '.xlsx': extractXlsxText,
};

export async function extractSourceDocs(sourceDir: string): Promise<ExtractResult> {
  const root = path.resolve(sourceDir);
  const docs: SourceDoc[] = [];
  const skipped: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      // Dot-directories are operator-local state (build outputs, VCS
      // metadata), never pack content — skip the whole subtree.
      if (entry.isDirectory() && entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      // lstat BEFORE any use: a symlink or junction inside the source tree is
      // refused, never dereferenced into the distributable pack.
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing symlink/junction in source folder: ${full}`);
      }
      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing non-regular source entry: ${full}`);
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      const extension = path.extname(entry.name).toLowerCase();
      const mime = SUPPORTED[extension];
      if (mime === undefined) {
        skipped.push(rel);
        continue;
      }
      const bytes = readFileSync(full);
      let title = stem(entry.name);
      let body: string;
      if (ASYNC_TEXT_EXTENSIONS.has(extension)) {
        const extractor = ASYNC_EXTRACTORS[extension];
        body = (extractor === undefined ? '' : await extractor(bytes)).trim();
      } else {
        body = bytes.toString('utf8');
        if (mime === 'application/json') {
          let parsed: JsonDocShape;
          try {
            parsed = JSON.parse(body) as JsonDocShape;
          } catch (error) {
            throw new Error(
              `${rel}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
            );
          }
          if (typeof parsed.text !== 'string') {
            throw new Error(`${rel}: JSON documents must carry a string "text" field`);
          }
          body = parsed.text;
          if (typeof parsed.title === 'string' && parsed.title.length > 0) title = parsed.title;
        } else if (mime === 'text/markdown') {
          const heading = markdownTitle(body);
          if (heading !== undefined) title = heading;
        }
      }
      docs.push({
        packPath: `docs/${rel}`,
        sourcePath: full,
        bytes,
        title,
        text: body,
        mime,
      });
    }
  };

  await walk(root);
  // Deterministic doc order: lexicographic by pack-relative path.
  docs.sort((a, b) => a.packPath.localeCompare(b.packPath));
  return { docs, skipped };
}
