#!/usr/bin/env node
/**
 * Build the FULL offline-capable testers bundle for a release.
 *
 * Usage: node scripts/build-portable-release.mjs [--out <dir>] [--mx <0-9>]
 *
 * Produces in <out> (default <repo>/.release-portable):
 *   TrainingApp-portable-<version>-<sha>-win64.7z.part-00, ...part-01, ...
 *   SHA256SUMS-parts.txt, <archive>.sha256, README-portable.txt
 *
 * A CI build.yml ZIP is NOT a testers release: it lacks the staged real
 * weights and both knowledge packs. This script is the canonical recipe.
 * Requires real model weights under models/ and both course packs under
 * desktop/knowledge-pack-src/, plus 7-Zip on PATH or at a standard location.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const mxFlag = args.indexOf('--mx');
const OUT = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(ROOT, '.release-portable'));
const MX = mxFlag >= 0 ? args[mxFlag + 1] : '5';
const PART_BYTES = 1900 * 1024 * 1024; // under GitHub's 2 GiB per-asset cap

const fail = (msg) => { console.error(`build-portable-release: ${msg}`); process.exit(1); };
const run = (cmd, args, cwd = ROOT) => {
  // shell=true on Windows does not quote an executable path with spaces.
  const executable = process.platform === 'win32' && cmd.includes(' ') ? `"${cmd}"` : cmd;
  console.log(`\n> ${cmd} ${args.join(' ')}  [${cwd}]`);
  const r = spawnSync(executable, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`command failed (${r.status}): ${cmd} ${args.join(' ')}`);
};
const npm = (cmd) => process.platform === 'win32' ? `npm.cmd` : 'npm';

if (!/^[0-9]$/.test(MX)) fail('--mx must be a single digit 0-9');

const { STAGED_MODELS } = await import(pathToFileURL(path.join(ROOT, 'desktop/scripts/stage-installer-resources.mjs')).href);
for (const model of STAGED_MODELS) {
  for (const rel of model.files) {
    const file = path.join(ROOT, 'models', model.id, rel);
    if (!fs.existsSync(file)) fail(`required real model weight missing: models/${model.id}/${rel} (stage it per PACKAGING.md; fixtures are forbidden)`);
    // Only weight binaries must be real; tokenizer/config files are legitimately small.
    if (/\.(gguf|onnx)$/.test(rel)) {
      const size = fs.statSync(file).size;
      if (size < 1024 * 1024) fail(`suspicious ${size}-byte model weight: models/${model.id}/${rel}`);
    }
  }
}
const packSrc = path.join(ROOT, 'desktop/knowledge-pack-src');
if (!fs.existsSync(packSrc) || fs.readdirSync(packSrc).length < 2) fail('both knowledge packs must be present in desktop/knowledge-pack-src/');

fs.mkdirSync(OUT, { recursive: true });

run(npm(), ['--prefix', 'web_ui', 'run', 'prepare-models']);
run(npm(), ['--prefix', 'web_ui', 'run', 'build:desktop']);
run(npm(), ['--prefix', 'desktop', 'run', 'compile']);
run(process.execPath, ['desktop/scripts/stage-installer-resources.mjs']);
run(process.execPath, ['desktop/scripts/build-installer-manifest.mjs', '--stage-dir', 'desktop/installer-resources', '--out', 'desktop/installer-resources/manifest.json']);
run('npx', ['electron-builder', '--win', '--dir', '--x64'], path.join(ROOT, 'desktop'));

const unpacked = path.join(ROOT, 'desktop/desktop-release/win-unpacked');
run(process.execPath, ['scripts/check-portable-bundle.mjs', unpacked]);

const sha = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
if (sha.status !== 0) fail('cannot resolve short HEAD sha');
const shortSha = sha.stdout.trim();
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8')).version ?? '0.1.0';
const archiveName = `TrainingApp-portable-${version}-${shortSha}-win64.7z`;
const archive = path.join(OUT, archiveName);

const readme = `TrainingApp portable build (real weights, offline-capable)
===========================================================
Build: master ${shortSha} (${new Date().toISOString().slice(0, 10)}), win-unpacked dir target
Contains: full real model weights (embedding, fast LLM, quality LLM,
reranker), both bundled knowledge packs, docs. Fully offline-capable.

Run: unpack this archive anywhere, then run TrainingApp.exe from the
win-unpacked folder. The app self-verifies resources/manifest.json at
every startup (a missing/corrupt file fails closed with named files).

Unsigned build (code signing deferred - ADR-0010): SmartScreen will
show an unknown-publisher warning on first run; choose More info ->
Run anyway.
`;
fs.writeFileSync(path.join(unpacked, 'README-portable.txt'), readme);
fs.writeFileSync(path.join(OUT, 'README-portable.txt'), readme);

const sevenZip = ['7z', 'C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe']
  .find((candidate) => spawnSync(candidate, ['i'], { encoding: 'utf8' }).status === 0);
if (!sevenZip) fail('7-Zip not found (PATH or standard Windows install path)');
run(sevenZip, ['a', '-t7z', `-mx=${MX}`, '-y', archive, 'win-unpacked'], path.join(ROOT, 'desktop/desktop-release'));
run(sevenZip, ['t', archive]);

const hashFile = (file) => {
  const h = createHash('sha256');
  const input = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    input.on('data', (chunk) => h.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(h.digest('hex')));
  });
};

const wholeHash = await hashFile(archive);
fs.writeFileSync(path.join(OUT, `${archiveName}.sha256`), `${wholeHash}  ${archiveName}\n`);

const partLines = [];
const input = fs.createReadStream(archive);
let partIndex = 0;
let partBytes = 0;
let partStream = null;
let partHash = createHash('sha256');
for await (const chunk of input) {
  let offset = 0;
  while (offset < chunk.length) {
    if (!partStream) {
      const name = `${archiveName}.part-${String(partIndex).padStart(2, '0')}`;
      partStream = fs.createWriteStream(path.join(OUT, name));
      partBytes = 0;
      partHash = createHash('sha256');
    }
    const room = PART_BYTES - partBytes;
    const take = Math.min(room, chunk.length - offset);
    const slice = chunk.subarray(offset, offset + take);
    partStream.write(slice);
    partHash.update(slice);
    partBytes += take;
    offset += take;
    if (partBytes === PART_BYTES) {
      await new Promise((resolve) => partStream.end(resolve));
      partLines.push(`${partHash.digest('hex')}  ${archiveName}.part-${String(partIndex).padStart(2, '0')}`);
      partStream = null;
      partIndex += 1;
    }
  }
}
if (partStream) {
  await new Promise((resolve) => partStream.end(resolve));
  partLines.push(`${partHash.digest('hex')}  ${archiveName}.part-${String(partIndex).padStart(2, '0')}`);
}
fs.writeFileSync(path.join(OUT, 'SHA256SUMS-parts.txt'), partLines.join('\n') + '\n');

console.log(`\nbuild-portable-release: OK — ${archiveName} (${wholeHash})`);
console.log(`Upload all ${partLines.length} parts + SHA256SUMS-parts.txt + ${archiveName}.sha256 + README-portable.txt to the release.`);
console.log(`Output directory: ${OUT}`);
