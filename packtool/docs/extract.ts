// docs/extract.ts — plain-document source extraction for build-docs (issue #73).
//
// Turns a folder of ordinary documents (.md, .txt, .json) into the doc-build
// inputs the shared build pipeline (chunker/embedder/index-writer) consumes:
// one SourceDoc per supported file, in deterministic lexicographic order of
// the forward-slash path relative to the source root. Non-regular entries
// (symlinks/junctions) are REFUSED — the same stance as build-storyline's
// copyTreeRejectingLinks — and unsupported extensions are skipped with a
// reported note so a source folder containing stray non-docs still builds
// predictably (a build that silently embedded everything would be the
// surprise, not one that lists what it ignored).
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
};

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

export function extractSourceDocs(sourceDir: string): ExtractResult {
  const root = path.resolve(sourceDir);
  const docs: SourceDoc[] = [];
  const skipped: string[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // lstat BEFORE any use: a symlink or junction inside the source tree is
      // refused, never dereferenced into the distributable pack.
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing symlink/junction in source folder: ${full}`);
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing non-regular source entry: ${full}`);
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      const mime = SUPPORTED[path.extname(entry.name).toLowerCase()];
      if (mime === undefined) {
        skipped.push(rel);
        continue;
      }
      const bytes = readFileSync(full);
      const text = bytes.toString('utf8');
      let title = stem(entry.name);
      let body = text;
      if (mime === 'application/json') {
        let parsed: JsonDocShape;
        try {
          parsed = JSON.parse(text) as JsonDocShape;
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
        const heading = markdownTitle(text);
        if (heading !== undefined) title = heading;
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

  walk(root);
  // Deterministic doc order: lexicographic by pack-relative path.
  docs.sort((a, b) => a.packPath.localeCompare(b.packPath));
  return { docs, skipped };
}
