// links/link-pack.ts — pack-level doc->slide link computation (D4/#80).
//
// The build-machine operation behind `packtool links --pack <docPack>
// --training <trainingPack>`: reads both packs (zip or unpacked directory,
// mirroring build/verify.ts's dual source), verifies the two embedding
// spaces are comparable (same model_id, same dims, both L2-normalized), then
// computes each doc chunk's top-K nearest training slides and REPLACES the
// doc pack's links rows in one transaction. This module is the library
// #73's build-docs will call; cli.ts is the thin production entry point.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import {
  INDEX_FILE_NAME,
  PACK_JSON_NAME,
  SOURCE_CLASS_TRAINING,
  validatePackManifest,
  type PackManifest,
} from '../build/pack-json.js';
import {
  computeDocSlideLinks,
  slideIdFromDocPath,
  DEFAULT_LINKS_COSINE_THRESHOLD,
  LINKS_TOP_K,
  type LinkChunk,
  type LinkRow,
  type LinkSlide,
} from './compute-links.js';

const require = createRequire(import.meta.url);
type LinkDb = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
};
const Database = require('better-sqlite3') as new (path: string, options?: { readonly?: boolean }) => LinkDb;
const sqliteVec = require('sqlite-vec') as { load(db: LinkDb): void };

export interface LinkPackOptions {
  threshold?: number;
  topK?: number;
}

export interface LinkPackResult {
  links: number;
  chunks: number;
  slides: number;
  threshold: number;
  topK: number;
  outputPath: string;
}

interface PackSource {
  readEntry(relPath: string): Promise<Buffer | undefined>;
  /** Materialize an entry as a real file (needed to open sqlite). */
  materialize(relPath: string): Promise<string | undefined>;
  dispose(): void;
}

function dirSource(root: string): PackSource {
  const resolve = (relPath: string): string => path.join(root, ...relPath.split('/'));
  return {
    async readEntry(relPath) {
      try {
        return fs.readFileSync(resolve(relPath));
      } catch {
        return undefined;
      }
    },
    async materialize(relPath) {
      return resolve(relPath);
    },
    dispose() {},
  };
}

async function zipSource(zipPath: string, scratchDir: string): Promise<PackSource> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  let extraction = 0;
  return {
    async readEntry(relPath) {
      const entry = zip.file(relPath);
      if (entry === null) return undefined;
      return Buffer.from(await entry.async('nodebuffer'));
    },
    async materialize(relPath) {
      const entry = zip.file(relPath);
      if (entry === null) return undefined;
      extraction += 1;
      const target = path.join(scratchDir, `entry-${extraction}.sqlite`);
      fs.writeFileSync(target, Buffer.from(await entry.async('nodebuffer')));
      return target;
    },
    dispose() {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

async function sourceFor(packPath: string, scratchDir: string): Promise<PackSource> {
  const resolved = path.resolve(packPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`pack not found: ${packPath}`);
  }
  return fs.statSync(resolved).isFile() ? await zipSource(resolved, scratchDir) : dirSource(resolved);
}

async function readManifest(source: PackSource, label: string): Promise<PackManifest> {
  const bytes = await source.readEntry(PACK_JSON_NAME);
  if (bytes === undefined) {
    throw new Error(`${label}: pack.json is missing from the pack`);
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as unknown;
  const shape = validatePackManifest(manifest);
  if (!shape.ok) {
    throw new Error(`${label}: invalid pack.json — ${shape.problems.join('; ')}`);
  }
  return manifest as PackManifest;
}

/**
 * Decode a stored embedding: sqlite-vec returns vec0 values as float32 LE
 * blobs while raw writers serialize JSON arrays — accept both, refuse
 * anything else (fail loud on corrupt rows, mirroring loadSchemaSql).
 */
function decodeVector(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    if (value.byteLength % 4 !== 0) {
      throw new Error('stored embedding blob is not a float32 vector');
    }
    const floats = new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    return Array.from(floats);
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'number')) {
      throw new Error('stored embedding JSON is not a number array');
    }
    return parsed as number[];
  }
  throw new Error(`stored embedding has unsupported type ${typeof value}`);
}

function openIndex(dbPath: string, readonly: boolean, label: string): LinkDb {
  const db = new Database(dbPath, readonly ? { readonly: true } : undefined);
  try {
    sqliteVec.load(db);
    return db;
  } catch (error) {
    // Never leak the native handle on a failed open (Windows EPERM on
    // temp-dir cleanup otherwise).
    try {
      db.close();
    } catch {
      // fall through — the original error is the useful one
    }
    throw new Error(`${label}: could not open index (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Compute and write doc->slide links for a doc pack against a training pack.
 * Returns the row count written. Throws (with a caller-presentable message)
 * on missing packs, invalid manifests, non-training doc packs refused in
 * either direction of misuse, and embedding-space mismatches.
 */
export async function computeAndWriteLinks(
  packPath: string,
  trainingPath: string,
  options: LinkPackOptions = {},
): Promise<LinkPackResult> {
  const threshold = options.threshold ?? DEFAULT_LINKS_COSINE_THRESHOLD;
  const topK = options.topK ?? LINKS_TOP_K;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packtool-links-'));
  let docIndex: LinkDb | null = null;
  let trainIndex: LinkDb | null = null;
  let docSource: PackSource | null = null;
  let trainSource: PackSource | null = null;
  try {
    // Materializing zip entries writes scratch files under these dirs —
    // they must exist before sourceFor().
    fs.mkdirSync(path.join(scratchDir, 'doc'), { recursive: true });
    fs.mkdirSync(path.join(scratchDir, 'train'), { recursive: true });
    docSource = await sourceFor(packPath, path.join(scratchDir, 'doc'));
    trainSource = await sourceFor(trainingPath, path.join(scratchDir, 'train'));
    const docManifest = await readManifest(docSource, 'doc pack');
    const trainManifest = await readManifest(trainSource, 'training pack');
    if (docManifest.source_class === SOURCE_CLASS_TRAINING) {
      throw new Error(
        'doc pack refuses --pack with source_class "training": links relate DOC chunks to slides; rebuild the training pack instead',
      );
    }
    // Comparability guard (cosine is only meaningful within one embedding
    // space): same model, same width, both sides L2-normalized.
    const docEmb = docManifest.embedding;
    const trainEmb = trainManifest.embedding;
    if (docEmb.normalize !== true || trainEmb.normalize !== true) {
      throw new Error('embedding spaces are not comparable: both packs must carry normalize: true embeddings');
    }
    if (docEmb.model_id !== trainEmb.model_id) {
      throw new Error(
        `embedding spaces are not comparable: doc pack model "${docEmb.model_id}" != training pack model "${trainEmb.model_id}"`,
      );
    }
    if (docEmb.dims !== trainEmb.dims) {
      throw new Error(
        `embedding spaces are not comparable: doc pack dims ${String(docEmb.dims)} != training pack dims ${String(trainEmb.dims)}`,
      );
    }

    const docIndexPath = await docSource.materialize(INDEX_FILE_NAME);
    const trainIndexPath = await trainSource.materialize(INDEX_FILE_NAME);
    if (docIndexPath === undefined) throw new Error('doc pack: prebuilt index is missing from the pack');
    if (trainIndexPath === undefined) throw new Error('training pack: prebuilt index is missing from the pack');

    trainIndex = openIndex(trainIndexPath, true, 'training pack');
    const slideRows = trainIndex
      .prepare(
        "SELECT d.path AS path, e.embedding AS embedding FROM chunks c JOIN docs d ON d.id = c.doc_id JOIN embeddings e ON e.chunk_id = c.id WHERE d.source_class = 'training'",
      )
      .all() as Array<{ path: string; embedding: unknown }>;
    const slides: LinkSlide[] = [];
    for (const row of slideRows) {
      const slideId = slideIdFromDocPath(row.path);
      if (slideId === null) continue; // non-slide training doc: no deep-link target
      slides.push({ slideId, vector: decodeVector(row.embedding) });
    }
    if (slides.length === 0) {
      throw new Error('training pack carries no slide embeddings — rebuild it with build-storyline');
    }

    docIndex = openIndex(docIndexPath, false, 'doc pack');
    const chunkRows = docIndex
      .prepare(
        'SELECT c.id AS chunk_id, d.pack_id AS pack_id, e.embedding AS embedding FROM chunks c JOIN docs d ON d.id = c.doc_id JOIN embeddings e ON e.chunk_id = c.id',
      )
      .all() as Array<{ chunk_id: string; pack_id: unknown; embedding: unknown }>;
    const chunks: LinkChunk[] = chunkRows.map((row) => ({
      chunkId: row.chunk_id,
      packId: row.pack_id === null || row.pack_id === undefined ? null : String(row.pack_id),
      vector: decodeVector(row.embedding),
    }));

    const rows: LinkRow[] = computeDocSlideLinks(chunks, slides, { threshold, topK });

    docIndex.exec('BEGIN IMMEDIATE');
    try {
      docIndex.exec('DELETE FROM links');
      const insert = docIndex.prepare(
        'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(row.chunk_id, row.slide_id, row.pack_id, row.score, row.rank, row.computed_at);
      }
      docIndex.exec('COMMIT');
    } catch (error) {
      try {
        docIndex.exec('ROLLBACK');
      } catch {
        // nothing to roll back, or rollback failed — original error wins
      }
      throw error;
    }
    docIndex.close();
    docIndex = null;

    if (fs.statSync(path.resolve(packPath)).isFile()) {
      // Rewrite the zip entry with the updated index, preserving every
      // entry's original date (compose's determinism discipline), then
      // publish atomically.
      const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(packPath)));
      const entry = zip.file(INDEX_FILE_NAME);
      if (entry === null) throw new Error('doc pack: index entry vanished while rewriting');
      zip.file(INDEX_FILE_NAME, fs.readFileSync(docIndexPath), {
        date: entry.date,
        createFolders: false,
      });
      const updated = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const tempOut = `${path.resolve(packPath)}.tmp-${process.pid}`;
      fs.writeFileSync(tempOut, updated);
      fs.renameSync(tempOut, path.resolve(packPath));
    } else {
      const stagingIndex = path.join(path.resolve(packPath), ...INDEX_FILE_NAME.split('/'));
      const tempOut = `${stagingIndex}.tmp-${process.pid}`;
      fs.copyFileSync(docIndexPath, tempOut);
      fs.renameSync(tempOut, stagingIndex);
    }

    return {
      links: rows.length,
      chunks: chunks.length,
      slides: slides.length,
      threshold,
      topK,
      outputPath: path.resolve(packPath),
    };
  } finally {
    if (docIndex !== null) {
      try {
        docIndex.close();
      } catch {
        // best-effort; the finally chain must not mask the original error
      }
    }
    if (trainIndex !== null) {
      try {
        trainIndex.close();
      } catch {
        // best-effort
      }
    }
    docSource?.dispose();
    trainSource?.dispose();
  }
}
