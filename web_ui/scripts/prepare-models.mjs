#!/usr/bin/env node
/**
 * prepare-models.mjs — assemble the offline model assets into public/models/.
 *
 * The web app must run fully offline, so every model file is served same-origin
 * from public/models/. The large weight binaries are NOT committed to git; this
 * script copies them into place at packaging time. It is idempotent.
 *
 * Phase 1 scope:
 *   1. Copy the embedding model (bge-small-en-v1.5: ONNX + tokenizer) from the
 *      repo's root `models/` directory into public/models/embeddings/.
 *   2. Copy the ONNX Runtime WASM binaries (shipped inside node_modules) into
 *      public/models/ort/ so Transformers.js never reaches for the jsdelivr CDN.
 *
 * Phase 2 will extend this to copy/convert/split the LFM2-VL GGUF + mmproj.
 *
 * Usage:  node scripts/prepare-models.mjs   (or: npm run prepare-models)
 * Exit code is non-zero if a required source asset cannot be found.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLfsPointer } from './lib/lfs-detect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');
const REPO_ROOT = resolve(WEB_UI, '..');
const PUBLIC_MODELS = join(WEB_UI, 'public', 'models');

// `--no-llm`: build an embeddings-only / server-mode archive. Stages only the
// `core` + `optional` model groups and writes a Vite env marker so the runtime
// readiness gate (checkPackagedModels) does not flag the deliberately-absent
// browser-LLM runtime + weights as missing.
const NO_LLM = process.argv.slice(2).includes('--no-llm');

let hadError = false;

function log(msg) {
  process.stdout.write(`[prepare-models] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[prepare-models] WARN: ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[prepare-models] ERROR: ${msg}\n`);
  hadError = true;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Copy a single file, creating the destination directory. */
function copyInto(src, destFile) {
  ensureDir(dirname(destFile));
  copyFileSync(src, destFile);
}

/** Recursively copy a directory tree. */
function copyTree(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    if (statSync(src).isDirectory()) copyTree(src, dest);
    else copyFileSync(src, dest);
  }
}

/** Find the first existing path from a list of candidates. */
function firstExisting(candidates) {
  return candidates.find((p) => existsSync(p));
}

// ---------------------------------------------------------------------------
// 1. Embedding model: bge-small-en-v1.5 (ONNX + tokenizer)
// ---------------------------------------------------------------------------
function prepareEmbeddingModel() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'bge-small-en-v1.5'),
    join(WEB_UI, 'models', 'bge-small-en-v1.5'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'embeddings', 'bge-small-en-v1.5');

  if (!srcDir) {
    fail(
      'embedding model source not found. Expected models/bge-small-en-v1.5/ at the repo root. ' +
        'See PACKAGING.md for how to obtain it.'
    );
    return;
  }

  const onnx = join(srcDir, 'onnx', 'model.onnx');
  if (!existsSync(onnx) || statSync(onnx).size < 1024) {
    fail(
      `embedding ONNX weights missing or look like an LFS stub: ${onnx} ` +
        '(size < 1KB). Pull the real weights before packaging — see PACKAGING.md.'
    );
    return;
  }
  if (isLfsPointer(onnx)) {
    fail(
      `embedding ONNX weights are a Git-LFS pointer stub (not the real file): ${onnx}. ` +
        'Run `git lfs pull` (or copy the model from a machine that has the real weights) ' +
        'before packaging. See PACKAGING.md.'
    );
    return;
  }

  copyTree(srcDir, destDir);
  log(`embeddings -> ${destDir}`);
}

// ---------------------------------------------------------------------------
// 1b. Reranker model (OPTIONAL): cross-encoder/ms-marco-MiniLM-L-6-v2.
//     Reranking degrades gracefully when absent, so a missing source is a warning,
//     not a build failure.
// ---------------------------------------------------------------------------
function prepareRerankerModel() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'ms-marco-MiniLM-L-6-v2'),
    join(REPO_ROOT, 'models', 'cross-encoder', 'ms-marco-MiniLM-L-6-v2'),
    join(WEB_UI, 'models', 'ms-marco-MiniLM-L-6-v2'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'reranker', 'ms-marco-MiniLM-L-6-v2');

  if (!srcDir) {
    warn(
      'reranker model source not found (optional). Cross-encoder reranking will be ' +
        'disabled in the offline build. See PACKAGING.md to include it.'
    );
    return;
  }

  const onnx = join(srcDir, 'onnx', 'model.onnx');
  if (!existsSync(onnx) || statSync(onnx).size < 1024) {
    warn(`reranker ONNX missing or an LFS stub at ${onnx}; skipping (optional).`);
    return;
  }
  if (isLfsPointer(onnx)) {
    warn(`reranker ONNX is a Git-LFS pointer stub at ${onnx}; skipping (optional). Run \`git lfs pull\`.`);
    return;
  }

  copyTree(srcDir, destDir);
  log(`reranker (optional) -> ${destDir}`);
}

// ---------------------------------------------------------------------------
// 1c. wllama WASM runtime, staged at public/models/wllama/wasm/wllama.wasm
//     (the path passed to wllama as AssetsPathConfig.default). PLUS the offline
//     "compat" build (@wllama/wllama-compat) used when the browser lacks
//     JSPI/Memory64 — without it locally, wllama fetches compat from jsdelivr.
//     Needed for the browser 'wllama' engine; warnings (not failures) if absent.
// ---------------------------------------------------------------------------
function prepareWllamaRuntime() {
  // Modern runtime.
  const wasm = firstExisting([
    join(WEB_UI, 'node_modules', '@wllama', 'wllama', 'esm', 'wasm', 'wllama.wasm'),
    join(WEB_UI, 'node_modules', '@wllama', 'wllama', 'src', 'wasm', 'wllama.wasm'),
    join(REPO_ROOT, 'node_modules', '@wllama', 'wllama', 'esm', 'wasm', 'wllama.wasm'),
  ]);
  if (wasm) {
    copyInto(wasm, join(PUBLIC_MODELS, 'wllama', 'wasm', 'wllama.wasm'));
    log(`wllama runtime -> ${join(PUBLIC_MODELS, 'wllama', 'wasm', 'wllama.wasm')}`);
  } else {
    warn('wllama WASM runtime not found in node_modules. Run `npm install`.');
  }

  // Offline compat runtime (wasm + worker js).
  const compatDir = firstExisting([
    join(WEB_UI, 'node_modules', '@wllama', 'wllama-compat', 'wasm'),
    join(REPO_ROOT, 'node_modules', '@wllama', 'wllama-compat', 'wasm'),
  ]);
  const compatDest = join(PUBLIC_MODELS, 'wllama', 'compat');
  if (!compatDir) {
    warn(
      '@wllama/wllama-compat not found. On browsers without JSPI/Memory64, wllama ' +
        'would fetch its runtime from jsdelivr (breaks offline). Run `npm install`.'
    );
    return;
  }
  let copied = 0;
  for (const name of ['wllama.wasm', 'wllama.js']) {
    const src = join(compatDir, name);
    if (existsSync(src)) {
      copyInto(src, join(compatDest, name));
      copied++;
    }
  }
  if (copied > 0) log(`wllama compat (${copied} files) -> ${compatDest}`);
  else warn('wllama compat assets missing (wllama.wasm/wllama.js).');
}

// ---------------------------------------------------------------------------
// 1d. Browser LLM weights (OPTIONAL): LFM2.5-VL-450M GGUF + mmproj projector.
//     Large binaries assembled at packaging time; absence is a warning so an
//     embeddings-only / server-mode build still succeeds.
// ---------------------------------------------------------------------------
function prepareBrowserLLM() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'lfm2.5-vl-450m'),
    join(WEB_UI, 'models', 'lfm2.5-vl-450m'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'llm', 'lfm2.5-vl-450m');

  if (!srcDir) {
    warn(
      'browser LLM (LFM2.5-VL-450M) source not found at models/lfm2.5-vl-450m/ (optional). ' +
        'Browser wllama generation will be unavailable; server mode is unaffected. ' +
        'See PACKAGING.md to include model.gguf + mmproj.gguf.'
    );
    return;
  }

  const gguf = join(srcDir, 'model.gguf');
  const mmproj = join(srcDir, 'mmproj.gguf');
  let staged = 0;
  for (const [src, name] of [[gguf, 'model.gguf'], [mmproj, 'mmproj.gguf']]) {
    if (!existsSync(src) || statSync(src).size <= 1024) {
      warn(`browser LLM file missing or stub: ${src} (skipped).`);
      continue;
    }
    if (isLfsPointer(src)) {
      warn(`browser LLM file is a Git-LFS pointer stub: ${src} (skipped). Run \`git lfs pull\`.`);
      continue;
    }
    copyInto(src, join(destDir, name));
    staged++;
  }
  if (staged === 2) log(`browser LLM (LFM2.5-VL-450M) -> ${destDir}`);
}

// ---------------------------------------------------------------------------
// 2. ONNX Runtime WASM binaries (so transformers.js stays offline)
// ---------------------------------------------------------------------------
function prepareOnnxRuntimeWasm() {
  const candidateDirs = [
    join(WEB_UI, 'node_modules', '@huggingface', 'transformers', 'dist'),
    join(WEB_UI, 'node_modules', 'onnxruntime-web', 'dist'),
    join(REPO_ROOT, 'node_modules', '@huggingface', 'transformers', 'dist'),
    join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist'),
  ];
  const destDir = join(PUBLIC_MODELS, 'ort');
  ensureDir(destDir);

  let copied = 0;
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      // ORT ships .wasm and supporting .mjs/.js loaders; copy the wasm binaries
      // and any ort-*.mjs glue next to them.
      if (/^ort.*\.(wasm|mjs)$/.test(entry)) {
        copyInto(join(dir, entry), join(destDir, entry));
        copied++;
      }
    }
    if (copied > 0) break; // first dir that has them wins
  }

  if (copied === 0) {
    warn(
      'no ONNX Runtime JSEP .wasm files found in node_modules. Run `npm install` first, ' +
        'or copy ort-wasm-simd-threaded.jsep.wasm (and ort-wasm-simd-threaded.jsep.mjs) ' +
        'into public/models/ort/ manually. The app will not embed offline without them.'
    );
  } else {
    log(`onnxruntime wasm (${copied} files) -> ${destDir}`);
  }
}

// ---------------------------------------------------------------------------
log(`assembling offline model assets${NO_LLM ? ' (--no-llm: embeddings-only / server mode)' : ''}...`);
prepareEmbeddingModel();
prepareRerankerModel();
if (!NO_LLM) {
  prepareWllamaRuntime();
  prepareBrowserLLM();
} else {
  log('--no-llm: skipping browser-LLM runtime (wllama WASM/compat) + LFM2-VL weights.');
}
prepareOnnxRuntimeWasm();

// When --no-llm is set, record the excluded group so the runtime readiness gate
// (checkPackagedModels) treats the llm group as "not applicable" rather than
// "missing". Vite loads `.env.production` for `vite build`, so writing here makes
// the value reach `import.meta.env.VITE_EXCLUDE_MODEL_GROUPS` at build time.
const ENV_FILE = join(WEB_UI, '.env.production');
const MARKER = 'VITE_EXCLUDE_MODEL_GROUPS=';
const desiredLine = NO_LLM ? `${MARKER}llm` : '';
let envLines = [];
if (existsSync(ENV_FILE)) {
  envLines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith(MARKER) && l.trim() !== '');
}
if (desiredLine) {
  envLines.push(desiredLine);
}
// Only touch the file when content actually changes (avoid rewriting on every run).
const newEnvContent = envLines.join('\n').replace(/\n+$/, '\n');
const oldEnvContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
if (newEnvContent !== oldEnvContent) {
  writeFileSync(ENV_FILE, newEnvContent || '');
  if (NO_LLM) log('wrote VITE_EXCLUDE_MODEL_GROUPS=llm to .env.production');
}

if (hadError) {
  fail('one or more REQUIRED assets are missing. Build is NOT offline-ready.');
  process.exit(1);
}
log('done. public/models/ is ready for an offline build.');
