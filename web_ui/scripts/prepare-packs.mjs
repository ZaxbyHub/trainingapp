#!/usr/bin/env node
/**
 * prepare-packs.mjs — stage the bundled knowledge/training pack archives for
 * the WEB build (issue #266, AC15).
 *
 * Desktop parity: the browser app ships the SAME bundled pack set the desktop
 * installer stages. The selection is NEVER a zip-directory enumeration — it is
 * the pinned selector in scripts/lib/pack-selector.mjs (docs pack +
 * opmed-cdp-mlc-1.0.1 from the operator root desktop/knowledge-pack-src/, or
 * the SILENT contracts/fixtures/packs/bundled-min fixture fallback when that
 * root is wholly absent — maintainer decision, comment 6825526111).
 *
 * Output (web_ui/public/packs/, copied to dist/packs/ by `vite build`):
 *   <id>-<version>.zip            — deterministic archives of each pack dir
 *   packs.manifest.json           — { packs: [{ id, version, file, sha256, size }] }
 *
 * The zip writer adapts packtool/build/zip.ts writeDeterministicZip's
 * conventions (issue #73 C6): lstat refusal for non-regular entries, explicit
 * sorted directory entries, pack.json exactly once at the archive root,
 * forward-slash relative entry paths, the manifest published_at as every
 * entry's date, DEFLATE level 9, and an atomic sibling-temp + rename publish.
 * It ARCHIVES built pack directories; it never runs packtool build verbs
 * (those rebuild content, not archives).
 *
 * Import-safe (harness-runner contract): importing this module executes
 * nothing — the entry guard drives the staging only on direct execution.
 *
 * Usage: node scripts/prepare-packs.mjs
 * Exit code non-zero on any failure (incomplete/unexpected operator trees
 * fail LOUD by name; the fixture fallback is silent and logged).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { resolveBundledPackSources } from './lib/pack-selector.mjs';

const SCRIPT = 'prepare-packs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI = path.resolve(here, '..');
const REPO_ROOT = path.resolve(WEB_UI, '..');

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/**
 * Every regular file under `root`, as forward-slash paths relative to root.
 * Non-regular entries (symlinks, FIFOs — anything lstat does not report as a
 * plain file, or a directory entry readdir reports as a symlink) are REFUSED
 * loudly: a symlinked pack tree must never be silently flattened into an
 * archive whose hashes then disagree with the operator's intent (mirrors
 * packtool/build/zip.ts's refusal discipline).
 *
 * @param {(p: string) => fs.Stats} [statImpl] stat seam (tests).
 */
export function listPackFilesRelative(root, statImpl = (p) => fs.lstatSync(p), dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listPackFilesRelative(root, statImpl, full));
      continue;
    }
    const st = statImpl(full);
    if (!st.isFile()) {
      throw new Error(
        `non-regular entry in pack source tree (refused): ${path.relative(root, full) || entry.name}`,
      );
    }
    out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Deterministically archive a built pack directory (packtool
 * writeDeterministicZip conventions; see the header).
 *
 * @param {string} staging Absolute pack source dir (pack.json at its root).
 * @param {string} outPath Destination zip path.
 * @param {Date} zipDate Every entry's date (the manifest published_at).
 * @returns {Promise<Buffer>} The zip bytes (the caller hashes the in-memory
 *   buffer — REL-7 — instead of re-reading the file back).
 */
export async function writeDeterministicPackZip(staging, outPath, zipDate) {
  const zip = new JSZip();
  const entryPaths = listPackFilesRelative(staging).sort((a, b) => a.localeCompare(b));
  const dirEntries = new Set();
  for (const rel of entryPaths) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirEntries.add(`${parts.slice(0, i).join('/')}/`);
    }
  }
  for (const dir of [...dirEntries].sort((x, y) => x.localeCompare(y))) {
    zip.file(dir, null, { date: zipDate, createFolders: false, dir: true });
  }
  // pack.json sits at the archive root exactly once: it is a regular file in
  // the staged tree and is emitted with the other sorted file entries.
  for (const rel of entryPaths) {
    zip.file(rel, fs.readFileSync(path.join(staging, rel)), { date: zipDate, createFolders: false });
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  // Atomic publish: sibling temp file + rename, so a crash mid-write can
  // never leave a torn zip at the user-visible path.
  const tempOut = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempOut, buffer);
  fs.renameSync(tempOut, outPath);
  return buffer;
}

/**
 * Atomic text publish (REL-5): sibling temp file + rename — the same publish
 * discipline as the zips — so a crash mid-write can never leave a torn
 * packs.manifest.json at the user-visible path.
 */
function writeTextAtomically(filePath, contents) {
  const tempOut = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempOut, contents, 'utf8');
  fs.renameSync(tempOut, filePath);
}

/**
 * The staging seam: select the pack sources, archive each into outDir, and
 * write the manifest. Returns { problems, manifest, source } — problems is
 * EMPTY on success (the caller fails loud); nothing is written when the
 * selector reported problems.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] Repository root (defaults to ../..).
 * @param {string} [opts.outDir] Output dir (defaults to <web_ui>/public/packs).
 * @param {string} [opts.manifestPath] Manifest path (defaults to <outDir>/packs.manifest.json).
 * @param {(message: string) => void} [opts.log]
 */
export async function stageBundledPacks(opts = {}) {
  const {
    repoRoot = REPO_ROOT,
    outDir = path.join(WEB_UI, 'public', 'packs'),
    manifestPath = path.join(outDir, 'packs.manifest.json'),
    log = (m) => console.log(`${SCRIPT}: ${m}`),
  } = opts;
  const problems = [];
  const report = (message) => problems.push(message);

  const knowledgePackSrcRoot = path.join(repoRoot, 'desktop', 'knowledge-pack-src');
  const fixturePackSource = path.join(repoRoot, 'contracts', 'fixtures', 'packs', 'bundled-min');
  const selection = resolveBundledPackSources({
    knowledgePackSrcRoot,
    fixturePackSource,
    onProblem: report,
  });

  /** @type {{packs: Array<{id: string; version: string; file: string; sha256: string; size: number}>}} */
  const manifest = { packs: [] };

  if (problems.length > 0) {
    return { problems, manifest, source: selection.source };
  }

  if (selection.source === 'fixture' && !fs.existsSync(fixturePackSource)) {
    // Neither source exists: an empty manifest is the honest artifact (the
    // app's boot ensure then finds nothing to install), named loudly.
    log(
      `NO bundled pack source: the operator root (${path.relative(repoRoot, knowledgePackSrcRoot)}) is absent and the fixture (${path.relative(repoRoot, fixturePackSource)}) is missing — staging an EMPTY packs manifest`,
    );
    fs.mkdirSync(outDir, { recursive: true });
    writeTextAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { problems, manifest, source: 'empty' };
  }

  if (selection.source === 'operator') {
    log(`source: operator ${path.relative(repoRoot, knowledgePackSrcRoot)} (docs + training packs)`);
  } else {
    log(
      `source: fixture ${path.relative(repoRoot, fixturePackSource)} (silent bundled-min fallback — the operator root is absent)`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  // REL-6: every zip THIS run wrote, so a problems-before-manifest exit can
  // roll them back — the on-disk manifest (if any) still describes the
  // PREVIOUS run's archives, and this run's half-staged zips must not be
  // left next to it as an inconsistent pair.
  const writtenZips = [];
  for (const pack of selection.packs) {
    const packJsonPath = path.join(pack.source, 'pack.json');
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
    } catch (err) {
      report(`pack manifest unreadable ${packJsonPath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (typeof meta.id !== 'string' || meta.id.length === 0) {
      report(`pack manifest ${packJsonPath} has no id`);
      continue;
    }
    const version = String(meta.version ?? '1.0.0');
    const file = `${meta.id}-${version}.zip`;
    const outPath = path.join(outDir, file);
    try {
      // REL-7: the writer returns the in-memory zip buffer — the manifest's
      // sha256/size are computed from it directly (identical bytes to what
      // the atomic rename published), with no whole-file re-read.
      const buffer = await writeDeterministicPackZip(pack.source, outPath, new Date(meta.published_at ?? 0));
      writtenZips.push(outPath);
      manifest.packs.push({
        id: meta.id,
        version,
        file,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length,
      });
    } catch (err) {
      report(`archiving ${path.relative(repoRoot, pack.source)} failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    log(`staged ${pack.classDir}/${meta.id}-${version} -> ${path.relative(repoRoot, outPath)}`);
  }

  if (problems.length > 0) {
    // REL-6: roll back the just-written zips (best-effort, fail-loud on
    // rollback errors) so the previous manifest+zips pair stays consistent.
    // Delta review r2 question — why unlink even a path a previous run
    // staged: the atomic rename already destroyed that file's previous
    // bytes, so sparing it would leave the OLD manifest hashing NEW bytes
    // (a silent corruption lookalike). Unlinking fails loudly at
    // validate-build ("missing") instead, which is the honest outcome.
    for (const zipPath of writtenZips) {
      try {
        fs.unlinkSync(zipPath);
      } catch (err) {
        report(
          `rolling back just-written zip ${path.relative(repoRoot, zipPath)} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { problems, manifest, source: selection.source };
  }
  writeTextAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${manifest.packs.length} pack entr${manifest.packs.length === 1 ? 'y' : 'ies'} -> ${path.relative(repoRoot, manifestPath)}`);
  return { problems, manifest, source: selection.source };
}

async function main() {
  const { problems } = await stageBundledPacks();
  if (problems.length > 0) {
    for (const message of problems) console.error(`${SCRIPT}: FAIL ${message}`);
    console.error(`${SCRIPT}: staging FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    process.exitCode = 1;
    return;
  }
  console.log(`${SCRIPT}: staging complete`);
}

// Entry guard: only direct execution drives the staging.
if (isMain(import.meta.url)) {
  await main();
}
