#!/usr/bin/env node
// build-knowledge-pack.mjs — build the initial knowledge pack from the
// operator's local document corpus (issue #133).
//
// Orchestrates the packtool pipeline over <repo>/knowledgepack (operator-
// supplied .docx/.pdf/.xlsx/.md/.txt/.json sources — untracked, like model
// weights):
//   1. packtool build-docs knowledgepack/ --id opmed-initial --embedder onnx
//      (bge-small-en-v1.5 from <repo>/models) -o desktop/knowledge-pack-src/
//      opmed-initial-<version>.zip
//   2. packtool verify the zip
//   3. unzip to desktop/knowledge-pack-src/opmed-initial-<version>/ (the
//      pack-dir shape stage-installer-resources.mjs stages when present)
//
// Outputs live OUTSIDE desktop/installer-resources on purpose: the stager
// wipes that directory wholesale at the start of every build, while
// knowledge-pack-src/ is a build INPUT it only reads. Fixed --published-at
// keeps rebuilds byte-deterministic (packtool zips are deterministic).
//
// Usage: node desktop/scripts/build-knowledge-pack.mjs [--version 1.0.0]
// A bare `--version` (no value) fails loud with exit 2 (issue #216 AC4);
// the default version when the flag is absent is documented below.
//
// Import-safe (issue #216 AC5): importing this module executes nothing —
// only direct execution drives the build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'build-knowledge-pack';
const PACK_ID = 'opmed-initial';
const PACK_NAME = 'OpMed Initial Knowledge Pack';
// Fixed timestamp: packtool derives deterministic zip entry dates from it.
const PUBLISHED_AT = '2026-09-24T00:00:00Z';

/** Documented default when --version is absent. */
export const DEFAULT_PACK_VERSION = '1.0.0';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Resolve --version from argv (issue #216 AC4): the documented default when
 * absent; the value when present with one; a loud error when bare.
 */
export function resolveVersionArgv(argv) {
  const i = argv.indexOf('--version');
  if (i === -1) return DEFAULT_PACK_VERSION;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--version requires a value');
  }
  return value;
}

/** Refuse non-semver versions and versions that could escape the output dir. */
export function validatePackVersion(packVersion) {
  if (!SEMVER_PATTERN.test(packVersion)) {
    throw new Error(`--version must be semver (X.Y.Z[-pre][+build]), got: ${packVersion}`);
  }
}

function die(message, code = 1) {
  console.error(`${SCRIPT}: FAIL ${message}`);
  process.exit(code);
}

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function main(argv) {
  let packVersion;
  try {
    packVersion = resolveVersionArgv(argv);
    validatePackVersion(packVersion);
  } catch (err) {
    // Issue #216 AC4: a valueless value-requiring flag fails loud (exit 2),
    // never a silent default.
    die(err instanceof Error ? err.message : String(err), 2);
    return 2;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktopDir = path.resolve(here, '..');
  const repoRoot = path.resolve(desktopDir, '..');
  const sourceDir = path.join(repoRoot, 'knowledgepack');
  const outDir = path.join(desktopDir, 'knowledge-pack-src');
  // Review PRR-232: validate BEFORE any rmSync — PACK_VERSION reaches the paths
  // below, and a crafted value (e.g. `--version ../..`) must be refused before
  // it can point a recursive delete outside the output directory.
  const zipPath = path.join(outDir, `${PACK_ID}-${packVersion}.zip`);
  const packDir = path.join(outDir, `${PACK_ID}-${packVersion}`);
  if (path.resolve(packDir) !== path.resolve(outDir, path.basename(packDir))) {
    die(`--version must not escape the output directory: ${packVersion}`);
  }
  const packtoolCli = path.join(repoRoot, 'packtool', 'dist', 'cli.js');
  const embedModelDir = path.join(repoRoot, 'models', 'bge-small-en-v1.5');

  function run(command, args, label) {
    console.log(`${SCRIPT}: ${label}`);
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot });
    if (result.status !== 0) {
      die(`${label} failed (exit ${result.status})`);
    }
  }

  if (!fs.existsSync(sourceDir)) {
    die(`knowledge source folder missing: ${sourceDir} (place the initial document pack there — it is operator-local, like models/)`);
  }
  if (!fs.existsSync(path.join(embedModelDir, 'onnx', 'model.onnx'))) {
    die(`embedding model missing: ${embedModelDir}/onnx/model.onnx (stage bge-small-en-v1.5 per PACKAGING.md)`);
  }
  if (!fs.existsSync(packtoolCli)) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npmCommand, ['--prefix', path.join(repoRoot, 'packtool'), 'run', 'build'], 'building packtool first');
    if (!fs.existsSync(packtoolCli)) die('packtool build produced no dist/cli.js');
  }

  fs.rmSync(zipPath, { force: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  run(process.execPath, [
    packtoolCli,
    'build-docs', sourceDir,
    '--id', PACK_ID,
    '--version', packVersion,
    '--name', PACK_NAME,
    '--source-class', 'bundled',
    '--embedder', 'onnx',
    '--embedding-model', embedModelDir,
    '--published-at', PUBLISHED_AT,
    '-o', zipPath,
  ], `building the knowledge pack from ${path.relative(repoRoot, sourceDir)}/ (onnx embeddings; this can take minutes)`);

  run(process.execPath, [packtoolCli, 'verify', zipPath], 'verifying the pack');

  // Unpack the verified zip into the pack-dir shape the stager consumes. The
  // ZIP is the authoritative artifact (deterministic, verified); this dir only
  // feeds stage-installer-resources.mjs's cpSync. Expand-Archive ships with
  // Windows PowerShell — no extra dependency for this operator-local step.
  run('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${packDir.replace(/'/g, "''")}' -Force`,
  ], 'unpacking the pack dir for staging');

  if (!fs.existsSync(path.join(packDir, 'pack.json'))) {
    die(`unpacked pack is missing pack.json under ${packDir}`);
  }
  console.log(`${SCRIPT}: OK -> ${path.relative(repoRoot, zipPath)} (+ unpacked ${path.relative(repoRoot, packDir)}/)`);
  console.log(`${SCRIPT}: stage-installer-resources.mjs will now stage this pack (it replaces the bundled-min fixture when present).`);
  return 0;
}

// Entry guard (issue #216 AC5): only direct execution drives the build.
if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)) ?? 0);
}
