// docs/build-docs.ts — packtool build-docs orchestrator (issue #73, C6).
//
// Generalizes the build-storyline pipeline to plain documents: a folder of
// .md/.txt/.json files becomes one installable Knowledge Pack with a PREBUILT
// index.sqlite (embeddings + FTS5), so end-user installs never re-embed.
// Everything content-specific lives in docs/extract.ts; chunking, embedding,
// index writing, manifest serialization, and deterministic zipping are the
// shared build plumbing (build/chunk.ts, build/embedder.ts,
// build/index-writer.ts, build/pack-json.ts, build/zip.ts).
//
// Differences from build-storyline (all per the C1 schema, ADR-0004):
//   - source_class defaults to "bundled" (--source-class bundled|training|user)
//   - chunking.strategy stamps "fixed-words" (the C1 fixture convention for
//     non-slide content; the chunker itself is the same shared TextChunker)
//   - no player assets, no course outline, no meta.xml identity: the pack id
//     comes from --id or a slug of the source folder name
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkIdFor, chunkSlideText, contentHashFor, docIdFor, normalizedText } from '../build/chunk.js';
import { resolveBuildEmbedder } from '../build/embedder.js';
import { findRepoRoot, writePackIndex } from '../build/index-writer.js';
import { writeDeterministicZip } from '../build/zip.js';
import {
  INDEX_FILE_NAME,
  PACK_ID_PATTERN,
  SQLITE_VEC_PIN,
  STORE_SCHEMA_VERSION,
  slugifyPackId,
  SEMVER_PATTERN,
  type PackDocEntry,
  type PackManifest,
} from '../build/pack-json.js';
import { extractSourceDocs, type SourceDoc } from './extract.js';

export const SOURCE_CLASSES = ['bundled', 'training', 'user'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

export interface BuildDocsOptions {
  sourceDir: string;
  /** Output zip path (-o/--out). */
  out: string;
  embedder?: 'hash' | 'onnx';
  modelDir?: string;
  id?: string;
  version?: string;
  name?: string;
  publishedAt?: string;
  sourceClass?: string;
  /** Repository root (contracts/, models/); auto-discovered by default. */
  repoRoot?: string;
}

export interface BuildDocsResult {
  packPath: string;
  packId: string;
  docs: number;
  chunks: number;
  bytes: number;
}

interface DocBuild {
  entry: PackDocEntry;
  docId: string;
  chunkText: string;
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const SCHEMA_HINT = 'contracts/store.schema.sql';

/** The RAG text a plain document contributes: title line (when not already
 * the document's own heading) plus the body. An empty body contributes no
 * text at all — a filename-stem title is metadata, not content — so an
 * empty-text document yields zero chunks (compose.ts precedent). */
function docChunkText(doc: SourceDoc): string {
  const body = doc.text.trim();
  if (body.length === 0) return '';
  const title = doc.title.trim();
  if (title.length === 0 || body.startsWith(title)) return body;
  return `${title}\n\n${body}`;
}

export async function buildDocsPack(options: BuildDocsOptions): Promise<BuildDocsResult> {
  const sourceDir = path.resolve(options.sourceDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`sourceDir does not exist: ${options.sourceDir}`);
  }
  const outPath = path.resolve(options.out);
  // A failed build must not leave a stale pack from a previous run at --out
  // (compose.ts RB-2 precedent): remove it up front so failure = no artifact.
  if (existsSync(outPath)) {
    rmSync(outPath, { force: true });
  }
  const repoRoot = options.repoRoot ?? findRepoRoot(moduleDir());
  if (repoRoot === undefined) {
    throw new Error(`cannot locate ${SCHEMA_HINT} above ${moduleDir()}`);
  }

  const sourceClass = options.sourceClass ?? 'bundled';
  if (!(SOURCE_CLASSES as readonly string[]).includes(sourceClass)) {
    throw new Error(`source_class must be one of ${SOURCE_CLASSES.join('|')} (got ${JSON.stringify(sourceClass)})`);
  }

  const packId = options.id ?? slugifyPackId(path.basename(sourceDir));
  if (packId === undefined || !PACK_ID_PATTERN.test(packId)) {
    throw new Error(
      `cannot derive a valid pack id from ${path.basename(sourceDir)}; pass --id (pattern ^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$)`,
    );
  }
  const packName = options.name ?? packId;

  const embedderKind = options.embedder ?? 'onnx';
  const embedder = resolveBuildEmbedder({
    embedder: embedderKind,
    modelDir: options.modelDir,
    repoRoot,
  });

  const version = options.version ?? '1.0.0';
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`--version must be semver 2.0.0 (got ${JSON.stringify(version)})`);
  }
  const publishedAt = options.publishedAt ?? new Date().toISOString();

  const { docs, skipped } = extractSourceDocs(sourceDir);
  if (docs.length === 0) {
    throw new Error(`no supported documents (.md, .txt, .json) found in ${sourceDir}`);
  }
  // Skipped non-docs are reported on stderr so a build that ignores content
  // is never silent (the pack itself stays deterministic — notes are not
  // part of the artifact).
  for (const rel of skipped) {
    console.error(`build-docs: skipping unsupported file: ${rel}`);
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'packtool-build-docs-'));
  try {
    // 1. Stage the pack tree: docs/<relative path>, bytes byte-for-byte.
    const staging = path.join(scratch, 'pack');
    mkdirSync(staging, { recursive: true });
    const docBuilds: DocBuild[] = [];
    for (const doc of docs) {
      const docId = docIdFor(doc.bytes);
      const target = path.join(staging, ...doc.packPath.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, doc.bytes);
      docBuilds.push({
        entry: { path: doc.packPath, sha256: docId, title: doc.title, mime: doc.mime },
        docId,
        chunkText: docChunkText(doc),
      });
    }

    // 2. Chunk + embed per document (chunks never cross documents; zero-text
    // documents contribute zero chunks and no embed call — compose precedent).
    const docRows = docBuilds.map((build) => ({
      docId: build.docId,
      path: build.entry.path,
      sha256: build.entry.sha256,
      title: build.entry.title,
      publishedAt,
    }));
    const chunkRows: Array<{
      chunkId: string;
      docId: string;
      chunkIndex: number;
      text: string;
      contentHash: string;
      vector: number[];
    }> = [];
    for (const build of docBuilds) {
      const chunks = chunkSlideText(build.chunkText);
      const texts = chunks.map((chunk) => chunk.text);
      const vectors = texts.length > 0 ? await embedder.embed(texts) : [];
      chunks.forEach((chunk, i) => {
        const normalized = normalizedText(chunk.text);
        const vector = vectors[i];
        if (vector === undefined) throw new Error(`embedder returned no vector for a chunk of ${build.entry.path}`);
        chunkRows.push({
          chunkId: chunkIdFor(build.docId, chunk.chunkIndex, normalized),
          docId: build.docId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          contentHash: contentHashFor(normalized),
          vector,
        });
      });
    }

    // 3. Manifest (fixed-words per the C1 bundled convention).
    const manifest: PackManifest = {
      id: packId,
      name: packName,
      version,
      published_at: publishedAt,
      source_class: sourceClass,
      embedding: { model_id: embedder.modelId, dims: embedder.dims, normalize: true },
      chunking: { strategy: 'fixed-words', size: 256, overlap: 100 },
      docs: docBuilds.map((build) => build.entry),
      index: { path: INDEX_FILE_NAME, schema_version: STORE_SCHEMA_VERSION, sqlite_vec_version: SQLITE_VEC_PIN },
    };

    // 4. Prebuilt index (schema applied from contracts/store.schema.sql).
    writePackIndex({
      dbPath: path.join(staging, INDEX_FILE_NAME),
      repoRoot,
      dims: embedder.dims,
      manifest,
      docs: docRows,
      chunks: chunkRows,
    });

    // 5. Deterministic zip via the shared writer.
    const bytes = await writeDeterministicZip(staging, manifest, outPath);

    return {
      packPath: outPath,
      packId,
      docs: docBuilds.length,
      chunks: chunkRows.length,
      bytes,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
