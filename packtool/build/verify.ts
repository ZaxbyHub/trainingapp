// build/verify.ts — packtool verify (issue #79).
//
// Validates a pack (zip or unpacked directory) the way #73's verify verb
// specifies: manifest conformance against the #68 draft shape, a per-doc
// sha256 re-hash of every bundled docs[] member (tamper detection), index
// stamp conformance (schema_version, embedding dims/model id, row-count
// equality, docs-table hash parity, packs-row id), and the player-assets
// anchor. Resolves to ok=true with "verify: OK" semantics on a good pack;
// one problem line per failure otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { assertSafeDocPath, validatePackManifest } from './pack-json.js';

const require = createRequire(import.meta.url);
type ReadonlyDatabase = {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
};
const Database = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => ReadonlyDatabase;
const sqliteVec = require('sqlite-vec') as { load(db: ReadonlyDatabase): void };

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  docs: number;
}

interface PackSource {
  /** Entry bytes, or undefined when absent (pack.json, docs/*). */
  readEntry(relPath: string): Promise<Buffer | undefined>;
  entryExists(relPath: string): boolean;
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
    entryExists(relPath) {
      return fs.existsSync(resolve(relPath));
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
    entryExists(relPath) {
      return zip.file(relPath) !== null;
    },
    async materialize(relPath) {
      // Only ever called for index.sqlite: extract to a scratch file so
      // better-sqlite3 can open it (no full-pack extraction).
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

export async function verifyPack(packPath: string): Promise<VerifyResult> {
  const problems: string[] = [];
  const resolved = path.resolve(packPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, problems: [`pack not found: ${packPath}`], docs: 0 };
  }
  const isZip = fs.statSync(resolved).isFile();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packtool-verify-'));
  const source = isZip ? await zipSource(resolved, scratchDir) : dirSource(resolved);
  try {
    // 1. Manifest present, parses, conforms to the #68 draft shape.
    const packJsonBytes = await source.readEntry('pack.json');
    if (packJsonBytes === undefined) {
      return { ok: false, problems: ['pack.json is missing from the pack'], docs: 0 };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(packJsonBytes.toString('utf8'));
    } catch (error) {
      return {
        ok: false,
        problems: [`pack.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
        docs: 0,
      };
    }
    const shape = validatePackManifest(manifest);
    problems.push(...shape.problems);
    if (!shape.ok) {
      return { ok: false, problems, docs: 0 };
    }
    const pack = manifest as {
      id: string;
      name: string;
      version: string;
      source_class: string;
      embedding: { model_id: string; dims: number; normalize: boolean };
      docs: Array<{ path: string; sha256: string; title: string; mime: string }>;
      index?: { path: string; schema_version: number; sqlite_vec_version: string };
    };

    // 2. Per-doc re-hash (the tamper detector).
    for (const doc of pack.docs) {
      try {
        assertSafeDocPath(doc.path);
      } catch (error) {
        problems.push(`${doc.path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const bytes = await source.readEntry(doc.path);
      if (bytes === undefined) {
        problems.push(`${doc.path}: bundled doc is missing from the pack`);
        continue;
      }
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== doc.sha256) {
        problems.push(`${doc.path}: sha256 mismatch (manifest ${doc.sha256}, actual ${actual})`);
      }
    }

    // 3. Prebuilt index stamps + row parity.
    const indexPath = pack.index?.path ?? 'index.sqlite';
    // Final-critic round 1 (defense in depth): the manifest guard rejects the
    // pack above, but verify's own read must not trust that alone.
    try {
      assertSafeDocPath(indexPath);
    } catch (error) {
      problems.push(`${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, problems, docs: pack.docs.length };
    }
    if (!source.entryExists(indexPath)) {
      problems.push(`${indexPath}: prebuilt index is missing from the pack`);
    } else {
      const indexFile = await source.materialize(indexPath);
      let db: ReadonlyDatabase | null = null;
      try {
        if (indexFile === undefined) throw new Error('entry could not be materialized');
        db = new Database(indexFile, { readonly: true });
        sqliteVec.load(db);
        const meta = (key: string): string | undefined => {
          const row = db?.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
          return row?.value;
        };
        if (meta('schema_version') !== '1') {
          problems.push(`index meta.schema_version is ${String(meta('schema_version'))}, want 1`);
        }
        // Cross-check the manifest's OWN declared schema version against the
        // index (PR review WD-2): a manifest claiming v2 over a v1 index must
        // not verify.
        if (
          pack.index !== undefined &&
          String(pack.index.schema_version) !== meta('schema_version')
        ) {
          problems.push(
            `index meta.schema_version ${String(meta('schema_version'))} != manifest index.schema_version ${String(pack.index.schema_version)}`,
          );
        }
        if (meta('embedding_dims') !== String(pack.embedding.dims)) {
          problems.push(
            `index meta.embedding_dims ${String(meta('embedding_dims'))} != manifest dims ${String(pack.embedding.dims)}`,
          );
        }
        if (meta('embedding_model_id') !== pack.embedding.model_id) {
          problems.push(
            `index meta.embedding_model_id ${String(meta('embedding_model_id'))} != manifest model_id ${pack.embedding.model_id}`,
          );
        }
        const count = (table: string): number => {
          const row = db?.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
          return row?.n ?? -1;
        };
        const chunks = count('chunks');
        const embeddings = count('embeddings');
        const fts = count('chunks_fts');
        if (chunks !== embeddings || chunks !== fts) {
          problems.push(`index row counts differ (chunks=${chunks}, embeddings=${embeddings}, chunks_fts=${fts})`);
        }
        const indexDocRows = db.prepare('SELECT sha256 FROM docs ORDER BY sha256').all() as Array<{
          sha256: string;
        }>;
        const indexHashes = indexDocRows.map((row) => row.sha256).sort().join(',');
        const manifestHashes = pack.docs.map((doc) => doc.sha256).sort().join(',');
        if (indexHashes !== manifestHashes) {
          problems.push('index docs table sha256 set does not match the manifest docs[] set');
        }
        const packRow = db
          .prepare('SELECT id, name, version, published_at, source_class FROM packs')
          .get() as
          | { id: string; name: string; version: string; published_at: string | null; source_class: string }
          | undefined;
        if (packRow === undefined || packRow.id !== pack.id) {
          problems.push(`index packs row id ${String(packRow?.id)} != manifest id ${pack.id}`);
        } else if (
          packRow.name !== pack.name ||
          packRow.version !== pack.version ||
          packRow.source_class !== pack.source_class
        ) {
          // PR review WD-3: full packs-row parity, not just the id.
          problems.push(
            `index packs row does not match the manifest (name/version/source_class differ)`,
          );
        }
      } catch (error) {
        problems.push(`index could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try {
          db?.close();
        } catch {
          // PR review RB-9: a close() failure must not mask the problems
          // already collected (or the original open error).
        }
      }
    }

    // 4. Player-assets anchor.
    if (!source.entryExists('assets/player/story.html')) {
      problems.push('assets/player/story.html is missing from the pack');
    }

    return { ok: problems.length === 0, problems, docs: pack.docs.length };
  } finally {
    source.dispose();
  }
}
