#!/usr/bin/env node
/**
 * prepare-models.mjs — assemble the offline model assets into public/models/.
 *
 * The web app must run fully offline, so every model file is served same-origin
 * from public/models/. The large weight binaries are NOT committed to git; this
 * script copies them into place at packaging time. It is idempotent.
 *
 * Phase 1 scope:
 *   1. Copy the embedding model (snowflake-arctic-embed-m-v1.5: q8 ONNX + tokenizer) from the
 *      repo's root `models/` directory into public/models/embeddings/.
 *   2. Copy the ONNX Runtime WASM binaries (shipped inside node_modules) into
 *      public/models/ort/ so Transformers.js never reaches for the jsdelivr CDN.
 *
 * Phase 2 will extend this to copy/convert/split the Gemma 4 E2B-it GGUF + mmproj.
 *
 * Usage:  node scripts/prepare-models.mjs   (or: npm run prepare-models)
 * Exit code is non-zero if a required source asset cannot be found.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
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
// `--no-reranker`: build without the cross-encoder reranker weights. Issue #37
// made the reranker REQUIRED for production packaging (retrieval quality depends
// on it), but CI builds on a fresh checkout do not stage the q8 ONNX (it is an
// operator-acquired weight, not in the repo). This flag lets CI produce a
// typecheck/build artifact without the reranker, while production packaging
// (which runs with weights staged) omits the flag and hard-fails if the q8
// ONNX is missing — catching a real packaging defect.
const NO_RERANKER = process.argv.slice(2).includes('--no-reranker');
// `--no-embedder`: build without the embedding model weights. Issue #37 R9
// swapped the embedder to snowflake-arctic-embed-m-v1.5 (operator-acquired q8
// ONNX, not in the repo / not under LFS). CI builds on a fresh checkout do not
// stage the q8 ONNX, so this flag lets CI produce a typecheck/build artifact
// without the embedder, while production packaging omits the flag and
// hard-fails if the q8 ONNX is missing. The runtime readiness gate treats the
// 'embedding' group as excluded via the env marker.
const NO_EMBEDDER = process.argv.slice(2).includes('--no-embedder');

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
// 1. Embedding model: snowflake-arctic-embed-m-v1.5 (768-dim, q8 ONNX + tokenizer)
//    Issue #37 R9: swapped from bge-small-en-v1.5 (384-dim fp32). Arctic loads
//    with dtype:'q8' → model_quantized.onnx (same DATA_TYPES.q8 → '_quantized'
//    rule as the reranker). Stage the q8 ONNX under that exact name.
// ---------------------------------------------------------------------------
function prepareEmbeddingModel() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'snowflake-arctic-embed-m-v1.5'),
    join(WEB_UI, 'models', 'snowflake-arctic-embed-m-v1.5'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'embeddings', 'snowflake-arctic-embed-m-v1.5');

  if (!srcDir) {
    fail(
      'embedding model source not found. Expected models/snowflake-arctic-embed-m-v1.5/ ' +
        'at the repo root. See PACKAGING.md for how to stage the q8 ONNX.'
    );
    return;
  }

  // Issue #37 R9: the embedder loads with dtype:'q8', which maps to
  // onnx/model_quantized.onnx (same DATA_TYPES.q8 → '_quantized' rule as the
  // reranker). Stage the q8 ONNX under that exact name.
  const onnx = join(srcDir, 'onnx', 'model_quantized.onnx');
  if (!existsSync(onnx) || statSync(onnx).size < 1024) {
    fail(
      `embedding q8 ONNX weights missing or look like an LFS stub: ${onnx} ` +
        '(size < 1KB). The embedder loads with dtype:\'q8\', which expects ' +
        'onnx/model_quantized.onnx (NOT model.onnx). Stage the q8 ONNX under ' +
        'that exact name — see PACKAGING.md.'
    );
    return;
  }
  if (isLfsPointer(onnx)) {
    fail(
      `embedding q8 ONNX weights are a Git-LFS pointer stub (not the real file): ${onnx}. ` +
        'Run `git lfs pull` (or copy the model from a machine that has the real weights) ' +
        'before packaging. See PACKAGING.md.'
    );
    return;
  }

  copyTree(srcDir, destDir);
  log(`embeddings (arctic q8) -> ${destDir}`);
}

// ---------------------------------------------------------------------------
// 1b. Reranker model: cross-encoder/ettin-reranker-32m-v1 (ModernBERT).
//     Issue #37 R9: swapped from ms-marco-MiniLM-L-6-v2. The reranker is
//     REQUIRED for retrieval quality. A missing source is a HARD FAILURE so CI
//     cannot silently ship a build with the reranker absent. Runtime fallback
//     still applies if init fails at load time (the orchestrator's isReady()
//     gate degrades gracefully), but packaging must not skip it.
// ---------------------------------------------------------------------------
function prepareRerankerModel() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'ettin-reranker-32m-v1'),
    join(REPO_ROOT, 'models', 'cross-encoder', 'ettin-reranker-32m-v1'),
    join(WEB_UI, 'models', 'ettin-reranker-32m-v1'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'reranker', 'ettin-reranker-32m-v1');

  if (!srcDir) {
    fail(
      'reranker model source not found. Expected models/ettin-reranker-32m-v1/ ' +
        'at the repo root (or models/cross-encoder/ettin-reranker-32m-v1/). ' +
        'Issue #37 made the reranker required — retrieval quality depends on it. ' +
        'See PACKAGING.md for how to stage the q8 ONNX (~33-36MB).'
    );
    return;
  }

  // transformers.js dtype:'q8' resolves to `model_quantized.onnx` (the
  // DATA_TYPES.q8 -> '_quantized' filename suffix). Stage the q8 ONNX under
  // that exact name; a non-quantized model.onnx would be silently ignored at
  // runtime and the reranker init would 404.
  const onnx = join(srcDir, 'onnx', 'model_quantized.onnx');
  if (!existsSync(onnx) || statSync(onnx).size < 1024) {
    fail(
      `reranker q8 ONNX weights missing or look like an LFS stub: ${onnx} ` +
        '(size < 1KB). The reranker loads with dtype:\'q8\', which expects ' +
        'onnx/model_quantized.onnx (NOT model.onnx). Stage the q8 ONNX under ' +
        'that exact name — see PACKAGING.md.'
    );
    return;
  }
  if (isLfsPointer(onnx)) {
    fail(
      `reranker q8 ONNX weights are a Git-LFS pointer stub (not the real file): ${onnx}. ` +
        'Run `git lfs pull` (or copy the model from a machine that has the real weights) ' +
        'before packaging. See PACKAGING.md.'
    );
    return;
  }

  copyTree(srcDir, destDir);
  log(`reranker -> ${destDir}`);
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
// 1d. Browser LLM weights (OPTIONAL): Gemma 4 E2B-it GGUF + mmproj projector.
//     Large binaries assembled at packaging time; absence is a warning so an
//     embeddings-only / server-mode build still succeeds.
// ---------------------------------------------------------------------------
function prepareBrowserLLM() {
  const srcDir = firstExisting([
    join(REPO_ROOT, 'models', 'gemma-4-e2b-it'),
    join(WEB_UI, 'models', 'gemma-4-e2b-it'),
  ]);
  const destDir = join(PUBLIC_MODELS, 'llm', 'gemma-4-e2b-it');

  if (!srcDir) {
    warn(
      'browser LLM (Gemma 4 E2B-it) source not found at models/gemma-4-e2b-it/ (optional). ' +
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
  if (staged === 2) log(`browser LLM (Gemma 4 E2B-it) -> ${destDir}`);
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
if (!NO_EMBEDDER) {
  prepareEmbeddingModel();
} else {
  log('--no-embedder: skipping embedding model weights (CI build). Semantic search will be unavailable without it; production packaging MUST omit this flag.');
}
if (!NO_RERANKER) {
  prepareRerankerModel();
} else {
  log('--no-reranker: skipping cross-encoder reranker weights (CI build). The orchestrator degrades to fused results without it; production packaging MUST omit this flag.');
}
if (!NO_LLM) {
  prepareWllamaRuntime();
  prepareBrowserLLM();
} else {
  log('--no-llm: skipping browser-LLM runtime (wllama WASM/compat) + Gemma 4 E2B-it weights.');
}
prepareOnnxRuntimeWasm();

// When --no-llm / --no-reranker is set, record the excluded group(s) so the
// runtime readiness gate (checkPackagedModels) treats the deliberately-absent
// group(s) as "not applicable" rather than "missing". Vite loads
// `.env.production` for `vite build`, so writing here makes the value reach
// `import.meta.env.VITE_EXCLUDE_MODEL_GROUPS` at build time. The env value is a
// comma-separated list (model-manifest.ts splits on ',').
const ENV_FILE = join(WEB_UI, '.env.production');
const MARKER = 'VITE_EXCLUDE_MODEL_GROUPS=';
const excludedGroups = [
  ...(NO_LLM ? ['llm'] : []),
  ...(NO_RERANKER ? ['reranker'] : []),
  ...(NO_EMBEDDER ? ['embedding'] : []),
];
const desiredLine = excludedGroups.length > 0 ? `${MARKER}${excludedGroups.join(',')}` : '';
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
  if (excludedGroups.length > 0) log(`wrote VITE_EXCLUDE_MODEL_GROUPS=${excludedGroups.join(',')} to .env.production`);
}

if (hadError) {
  fail('one or more REQUIRED assets are missing. Build is NOT offline-ready.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Issue #37 P4: record SHA-256 of every staged file into a sidecar
// `manifest.checksums.json` (read by validate-build.mjs). The checksums live
// beside manifest.json rather than mutating the source manifest, so the repo's
// manifest stays stable and the checksums are regenerated per-build (they
// capture the actual bytes staged THIS run, catching partial copies / wrong
// quantization swaps). Only files that actually exist in public/models/ are
// checksummed — `warn()`-skipped optionals are omitted (no false failure).
// ---------------------------------------------------------------------------
const MANIFEST_PATH = join(PUBLIC_MODELS, 'manifest.json');
const CHECKSUMS_PATH = join(PUBLIC_MODELS, 'manifest.checksums.json');
// Issue #37 P4: streaming SHA-256 — the wllama GGUF is ~2.9 GB, above Node's
// ~2 GB Buffer cap, so readFileSync would throw RangeError on the LLM weights.
async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
try {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const checksums = { version: manifest.version ?? 2, files: {} };
  const jobs = [];
  for (const model of manifest.models ?? []) {
    for (const f of model.files ?? []) {
      const staged = join(PUBLIC_MODELS, f.path);
      if (existsSync(staged) && statSync(staged).size > 0 && !isLfsPointer(staged)) {
        jobs.push({ path: f.path, staged });
      }
    }
  }
  // Hash concurrently (small file set; each is streamed to bound memory).
  const results = await Promise.all(
    jobs.map(async (job) => ({ path: job.path, hash: await sha256OfFile(job.staged) }))
  );
  for (const r of results) checksums.files[r.path] = r.hash;
  writeFileSync(CHECKSUMS_PATH, JSON.stringify(checksums, null, 2) + '\n');
  log(`wrote ${results.length} SHA-256 checksum(s) to public/models/manifest.checksums.json`);
} catch (e) {
  warn(`could not write checksum sidecar: ${e.message}`);
}

log('done. public/models/ is ready for an offline build.');
