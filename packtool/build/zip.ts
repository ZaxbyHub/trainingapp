// build/zip.ts — the shared deterministic zip writer (issue #73, C6).
//
// Extracted verbatim from compose.ts so build-docs and build-storyline emit
// byte-identical zip conventions: pack.json first, then explicit sorted
// directory entries, then the staged files — all carrying the fixed entry
// date derived from --published-at, with createFolders off (JSZip's
// auto-created folders would carry the CURRENT time, the one thing that
// would make two builds of identical input differ byte-wise) and DEFLATE
// level 9. Publish is atomic: sibling temp file + rename.
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { PACK_JSON_NAME, serializePackJson, type PackManifest } from './pack-json.js';

/** Every file under root, as forward-slash paths relative to root. */
export function listFilesRelative(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(root, full));
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Zip the staged pack tree deterministically; returns the zip byte length. */
export async function writeDeterministicZip(
  staging: string,
  manifest: PackManifest,
  outPath: string,
): Promise<number> {
  const zip = new JSZip();
  const zipDate = new Date(manifest.published_at);
  const entryPaths = listFilesRelative(staging);
  const dirEntries = new Set<string>();
  for (const rel of entryPaths) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirEntries.add(`${parts.slice(0, i).join('/')}/`);
    }
  }
  for (const dir of [...dirEntries].sort((x, y) => x.localeCompare(y))) {
    zip.file(dir, null, { date: zipDate, createFolders: false, dir: true });
  }
  zip.file(PACK_JSON_NAME, serializePackJson(manifest), { date: zipDate, createFolders: false });
  const entryPathsSorted = entryPaths.sort((a, b) => a.localeCompare(b));
  for (const rel of entryPathsSorted) {
    zip.file(rel, readFileSync(path.join(staging, rel)), { date: zipDate, createFolders: false });
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  // Atomic publish (PR review C3): write to a sibling temp file and rename
  // over --out, so a crash mid-write can never leave a torn zip at the
  // user-visible path.
  const tempOut = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tempOut, buffer);
  renameSync(tempOut, outPath);
  return buffer.length;
}
