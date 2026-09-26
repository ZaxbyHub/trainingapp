#!/usr/bin/env node
// build-training-pack.mjs — build the BUNDLED Articulate/Storyline training
// pack from the operator's local Storyline publish (issue #133 round 4).
//
// The Training tab is the Articulate course player; the operator requires a
// course pack to ship with the installer exactly like the bundled documents.
// This orchestrates `packtool build-storyline` (player assets + slide docs +
// prebuilt index) over the publish directory into
// desktop/knowledge-pack-src/opmed-cdp-mlc-<version>/ (the pack-dir shape the
// stager consumes; versioned managed layout <id>/<version> after install).
//
// Publish source resolution: --publish <dir> > TRAININGAPP_STORYLINE_PUBLISH
// env > the operator's known local path. The publish and the built pack are
// operator-local content (same rule as the model weights and knowledgepack/).
//
// Usage: node desktop/scripts/build-training-pack.mjs [--publish <dir>] [--version 1.0.1]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'build-training-pack';
const PACK_ID = 'opmed-cdp-mlc';
const PACK_NAME = 'OpMed CDP MicroLearning Companion';
const PUBLISHED_AT = '2026-09-25T00:00:00Z';
const DEFAULT_PUBLISH = 'E:\\ClaudeCode\\OpMed CDP MicroLearning Companion_7-10-26';

const versionArg = process.argv.includes('--version')
  ? process.argv[process.argv.indexOf('--version') + 1] ?? '1.0.1'
  : '1.0.1';
const publishArg = process.argv.includes('--publish')
  ? process.argv[process.argv.indexOf('--publish') + 1]
  : undefined;

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');
const publishDir = path.resolve(publishArg ?? process.env.TRAININGAPP_STORYLINE_PUBLISH ?? DEFAULT_PUBLISH);
const outDir = path.join(desktopDir, 'knowledge-pack-src');
const zipPath = path.join(outDir, `${PACK_ID}-${versionArg}.zip`);
const packDir = path.join(outDir, `${PACK_ID}-${versionArg}`);
const packtoolCli = path.join(repoRoot, 'packtool', 'dist', 'cli.js');
const embedModelDir = path.join(repoRoot, 'models', 'bge-small-en-v1.5');

function die(message) {
  console.error(`${SCRIPT}: FAIL ${message}`);
  process.exit(1);
}

function run(command, args, label) {
  console.log(`${SCRIPT}: ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot });
  if (result.status !== 0) {
    die(`${label} failed (exit ${result.status})`);
  }
}

if (!fs.existsSync(path.join(publishDir, 'story.html'))) {
  die(`Storyline publish not found (expected story.html): ${publishDir} — pass --publish <dir> or set TRAININGAPP_STORYLINE_PUBLISH`);
}
if (!fs.existsSync(path.join(embedModelDir, 'onnx', 'model.onnx'))) {
  die(`embedding model missing: ${embedModelDir}/onnx/model.onnx`);
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
  'build-storyline', publishDir,
  '--id', PACK_ID,
  '--version', versionArg,
  '--name', PACK_NAME,
  '--embedder', 'onnx',
  '--embedding-model', embedModelDir,
  '--published-at', PUBLISHED_AT,
  '--out', zipPath,
], `building the training pack from ${publishDir} (onnx embeddings; this can take minutes)`);

run(process.execPath, [packtoolCli, 'verify', zipPath], 'verifying the pack');

run('powershell.exe', [
  '-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${packDir.replace(/'/g, "''")}' -Force`,
], 'unpacking the pack dir for staging');

const storyCheck = path.join(packDir, 'assets', 'player', 'story.html');
if (!fs.existsSync(storyCheck)) {
  die(`unpacked training pack has no assets/player/story.html under ${packDir}`);
}
console.log(`${SCRIPT}: OK -> ${path.relative(repoRoot, zipPath)} (+ unpacked ${path.relative(repoRoot, packDir)}/)`);
console.log(`${SCRIPT}: stage-installer-resources.mjs will now stage this pack alongside the documents pack.`);
