// docs/diff.ts — packtool diff (issue #73, C6).
//
// Reports added/removed/changed docs (by manifest path and sha256) and the
// chunk-count delta between two Knowledge Packs (zip or unpacked directory),
// for release-note generation and CI review of pack changes. This is a
// REPORT, not a gate: any two valid packs diff with exit 0; load/manifest
// failures exit 1.
//
// Output contract (pinned by docs/__tests__/build-docs.test.ts and consumed
// by CI greps — do not reword):
//   added: <path> (sha256 <hash>)
//   removed: <path> (sha256 <hash>)
//   changed: <path> (sha256 <old> -> <new>)
//   chunks: <nA> -> <nB> (delta <±k>)        — or `chunks: n/a` when either
//                                              pack has no prebuilt index
//   summary: <a> added, <r> removed, <c> changed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { INDEX_FILE_NAME, validatePackManifest, type PackManifest } from '../build/pack-json.js';

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

export interface PackDiffEntry {
  path: string;
  sha256: string;
}

export interface PackDiff {
  added: PackDiffEntry[];
  removed: PackDiffEntry[];
  changed: Array<{ path: string; oldSha256: string; newSha256: string }>;
  /** Total chunk counts; null when that pack has no prebuilt index. */
  chunksA: number | null;
  chunksB: number | null;
}

interface PackHandle {
  manifest: PackManifest;
  /** Chunk total from the prebuilt index, or null when absent/unopenable. */
  chunkCount: number | null;
  dispose(): void;
}

async function readManifestBytes(sourcePath: string): Promise<Buffer> {
  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const entry = zip.file('pack.json');
    if (entry === null) throw new Error(`pack.json is missing from ${sourcePath}`);
    return Buffer.from(await entry.async('nodebuffer'));
  }
  const raw = fs.readFileSync(path.join(sourcePath, 'pack.json'));
  return raw;
}

async function openIndex(
  sourcePath: string,
  scratchDir: string,
  indexEntry: string,
): Promise<ReadonlyDatabase | null> {
  let indexFile: string | null = null;
  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const entry = zip.file(indexEntry);
    if (entry === null) return null;
    indexFile = path.join(scratchDir, 'index.sqlite');
    fs.writeFileSync(indexFile, Buffer.from(await entry.async('nodebuffer')));
  } else {
    // indexEntry is manifest-declared and passes assertSafeDocPath via
    // validatePackManifest, so the join cannot escape the pack root.
    const direct = path.join(sourcePath, ...indexEntry.split('/'));
    if (!fs.existsSync(direct)) return null;
    indexFile = direct;
  }
  const db = new Database(indexFile, { readonly: true });
  sqliteVec.load(db);
  return db;
}

async function openPack(sourcePath: string): Promise<PackHandle> {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`pack not found: ${sourcePath}`);
  }
  const bytes = await readManifestBytes(resolved);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `pack.json in ${sourcePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const shape = validatePackManifest(parsed);
  if (!shape.ok) {
    throw new Error(`${sourcePath}: invalid pack.json (${shape.problems[0] ?? 'unknown problem'})`);
  }
  const manifest = parsed as PackManifest;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packtool-diff-'));
  let chunkCount: number | null = null;
  let db: ReadonlyDatabase | null = null;
  try {
    // Honor the manifest's declared index location (parity with verify);
    // packs without an index block still get the conventional default name.
    db = await openIndex(resolved, scratchDir, manifest.index?.path ?? INDEX_FILE_NAME);
    if (db !== null) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number } | undefined;
      chunkCount = row?.n ?? null;
    }
  } catch {
    // An index that cannot be opened is reported as n/a, not a diff failure:
    // the doc-level comparison is manifest-only and still meaningful.
    chunkCount = null;
  } finally {
    try {
      db?.close();
    } catch {
      // As in verify.ts: a close failure must not mask collected results.
    }
  }
  return {
    manifest,
    chunkCount,
    dispose() {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

/** Diff two packs by manifest docs[] identity and prebuilt chunk totals. */
export async function diffPacks(aPath: string, bPath: string): Promise<PackDiff> {
  const a = await openPack(aPath);
  try {
    const b = await openPack(bPath);
    try {
      const aByPath = new Map(a.manifest.docs.map((doc) => [doc.path, doc]));
      const bByPath = new Map(b.manifest.docs.map((doc) => [doc.path, doc]));
      const added: PackDiffEntry[] = [];
      const removed: PackDiffEntry[] = [];
      const changed: PackDiff['changed'] = [];
      for (const [p, doc] of bByPath) {
        const old = aByPath.get(p);
        if (old === undefined) added.push({ path: p, sha256: doc.sha256 });
        else if (old.sha256 !== doc.sha256) {
          changed.push({ path: p, oldSha256: old.sha256, newSha256: doc.sha256 });
        }
      }
      for (const [p, doc] of aByPath) {
        if (!bByPath.has(p)) removed.push({ path: p, sha256: doc.sha256 });
      }
      const byPath = (x: PackDiffEntry, y: PackDiffEntry): number => x.path.localeCompare(y.path);
      added.sort(byPath);
      removed.sort(byPath);
      changed.sort((x, y) => x.path.localeCompare(y.path));
      return { added, removed, changed, chunksA: a.chunkCount, chunksB: b.chunkCount };
    } finally {
      b.dispose();
    }
  } finally {
    a.dispose();
  }
}

/**
 * The pinned report lines (see the module comment). One line per added /
 * removed / changed doc, exactly one chunks line, then the summary.
 */
export function formatPackDiff(diff: PackDiff): string[] {
  const lines: string[] = [];
  for (const doc of diff.added) {
    lines.push(`added: ${doc.path} (sha256 ${doc.sha256})`);
  }
  for (const doc of diff.removed) {
    lines.push(`removed: ${doc.path} (sha256 ${doc.sha256})`);
  }
  for (const doc of diff.changed) {
    lines.push(`changed: ${doc.path} (sha256 ${doc.oldSha256} -> ${doc.newSha256})`);
  }
  if (diff.chunksA === null || diff.chunksB === null) {
    lines.push('chunks: n/a');
  } else {
    const delta = diff.chunksB - diff.chunksA;
    const signed = delta >= 0 ? `+${delta}` : String(delta);
    lines.push(`chunks: ${diff.chunksA} -> ${diff.chunksB} (delta ${signed})`);
  }
  lines.push(`summary: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`);
  return lines;
}
