#!/usr/bin/env node
/**
 * stage-installer-resources.mjs — E1 (issue #84) installer resource stager.
 *
 * Two jobs, both owned by this script so the selection list lives in exactly
 * one testable place:
 *
 * 1. Assemble desktop/installer-resources/ in the issue-#84 layout:
 *      models/{embedding,reranker,llm-quality,llm-fast}/<id>/…
 *      packs/{bundled-docs,training}/<packId>-<version>/
 *      docs/licenses.md
 *    The staged models are the ones the packaged DESKTOP runtime actually
 *    loads at base (verified in the trace's localization): the OnnxEmbedder's
 *    bge-small-en-v1.5 fp32 onnx/model.onnx (embedder.ts), the rerank
 *    worker's ettin-reranker-32m-v1 q8 onnx/model_quantized.onnx, and the
 *    ADR-0002 LLM GGUF pairs. Explicit allow-lists — never a directory copy —
 *    so unselected leftovers on disk (gemma-4-e2b-it-qat/, bge safetensors,
 *    model-Q4_K_M-old.gguf, fp32 variants) cannot ship. A missing required
 *    source file FAILS the build by name (electron-builder's extraResources
 *    would silently skip a missing from: — staging must not).
 *
 * 2. Copy web_ui/dist → desktop/renderer for desktop:build, EXCLUDING the
 *    weight files that are duplicated into installer-resources/models/. The
 *    two trees use different group coordinates (staged
 *    models/llm-quality/gemma-4-e2b-it vs renderer dist models/llm/
 *    gemma-4-e2b-it), so the exclusion matches on the model-id directory
 *    name, not the staged path. Everything else in dist/models/ is KEPT
 *    (models/ort + models/manifest.json are hard requirements of the
 *    packaged renderer's offline env; the snowflake browser embedder stays).
 *    After the copy the script ASSERTS the (model-id) overlap between
 *    renderer/models and the staged weight set is empty — the double-ship
 *    guard that holds the <=7 GiB budget.
 *
 * --fixture-models: substitute tiny deterministic synthetic files at the same
 * staged model paths (CI has no multi-GB weights). Prints "MODE:
 * fixture-models" loudly; never mixes synthetic and real files. CI passes
 * --note "MODE: fixture-models" to the manifest generator so the mode travels
 * inside the artifact too.
 *
 * Usage:
 *   node desktop/scripts/stage-installer-resources.mjs [--fixture-models] [--skip-renderer-copy]
 * Exit code non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'stage-installer-resources';

const args = {
  fixtureModels:
    process.argv.includes('--fixture-models') ||
    process.env.TRAININGAPP_INSTALLER_FIXTURE_MODELS === '1',
  skipRendererCopy: process.argv.includes('--skip-renderer-copy'),
};

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');
const stageDir = path.join(desktopDir, 'installer-resources');
const rendererDir = path.join(desktopDir, 'renderer');
const webUiDist = path.join(repoRoot, 'web_ui', 'dist');

const errors = [];
function fail(message) {
  errors.push(message);
}

/**
 * The staged model inventory. Files are repo-root-relative under models/.
 * Byte sizes recorded 2026-09-23 (informational; the manifest generator's
 * sizeBytes is the authority). Exported so the committed specs can pin the
 * consumer contract (root tokenizer files etc.) without executing the script.
 */
export const STAGED_MODELS = [
  {
    group: 'embedding',
    id: 'bge-small-en-v1.5',
    label: 'BAAI/bge-small-en-v1.5 (embeddings, 384-dim, fp32 ONNX)',
    files: [
      'config.json',
      'onnx/model.onnx',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'vocab.txt',
    ],
  },
  {
    group: 'reranker',
    id: 'ettin-reranker-32m-v1',
    label: 'cross-encoder/ettin-reranker-32m-v1 (reranker, q8 ONNX)',
    // Root tokenizer files are REQUIRED alongside onnx/: rerank-worker.ts
    // loads AutoTokenizer.from_pretrained(modelDir) from the model ROOT (the
    // implementation-review CRITICAL finding — a staged tree without them
    // passes the hash gate but 500s every retrieval query after ingest).
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
      'onnx/config.json',
      'onnx/tokenizer.json',
      'onnx/tokenizer_config.json',
    ],
  },
  {
    group: 'llm-quality',
    id: 'gemma-4-e2b-it',
    label: 'Google Gemma 4 E2B-it Q4_K_M (Quality LLM, ADR-0002)',
    files: ['model.gguf', 'mmproj.gguf'],
  },
  {
    group: 'llm-fast',
    id: 'lfm2.5-vl-450m',
    label: 'LFM 2.5 VL 450M Q4_K_M (Fast LLM, ADR-0002)',
    files: ['model.gguf', 'mmproj.gguf'],
  },
];

/** Renderer-copy exclusion key: model-id directories whose staged weights
 *  must not ALSO ship inside the packaged web_ui renderer copy. */
const RENDERER_EXCLUDED_MODEL_IDS = new Set(STAGED_MODELS.map((m) => m.id));

const STAGED_PACKS = [
  { source: path.join(repoRoot, 'contracts', 'fixtures', 'packs', 'bundled-min'), classDir: 'bundled-docs' },
  { source: path.join(repoRoot, 'contracts', 'fixtures', 'packs', 'training-stub'), classDir: 'training' },
];

function rmSyncBestEffort(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    fail(`could not clean ${target} (${err instanceof Error ? err.message : err}) — close editors/indexers holding it and retry`);
  }
}

function copyFileSyncLoud(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.copyFileSync(from, to);
  } catch (err) {
    fail(`copy failed ${from} -> ${to}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Deterministic synthetic stand-in for a real weight (fixture mode). */
function writeFixtureFile(to, relName) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const marker = `FIXTURE-MODELS stand-in for ${relName} (issue #84 CI staging; not a real weight)\n`;
  const size = Math.max(1024, marker.length * 8);
  const chunk = Buffer.from(marker, 'utf8');
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = chunk[i % chunk.length];
  fs.writeFileSync(to, out);
}

function stageModels() {
  let staged = 0;
  for (const model of STAGED_MODELS) {
    for (const rel of model.files) {
      const src = path.join(repoRoot, 'models', model.id, rel);
      const dst = path.join(stageDir, 'models', model.group, model.id, rel);
      if (args.fixtureModels) {
        writeFixtureFile(dst, `models/${model.id}/${rel}`);
        staged += 1;
        continue;
      }
      if (!fs.existsSync(src)) {
        fail(`required model file missing: ${path.relative(repoRoot, src)} (stage it per PACKAGING.md, or pass --fixture-models for CI)`);
        continue;
      }
      copyFileSyncLoud(src, dst);
      staged += 1;
    }
  }
  console.log(`${SCRIPT}: staged ${staged} model files into ${path.relative(repoRoot, stageDir)}/models/`);
}

function stagePacks() {
  for (const pack of STAGED_PACKS) {
    const packJsonPath = path.join(pack.source, 'pack.json');
    if (!fs.existsSync(packJsonPath)) {
      fail(`pack fixture missing: ${path.relative(repoRoot, packJsonPath)}`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
    } catch (err) {
      fail(`pack fixture unreadable ${packJsonPath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (typeof meta.id !== 'string' || meta.id.length === 0) {
      fail(`pack fixture ${packJsonPath} has no id`);
      continue;
    }
    const version = String(meta.version ?? '1.0.0');
    const dst = path.join(stageDir, 'packs', pack.classDir, `${meta.id}-${version}`);
    fs.cpSync(pack.source, dst, { recursive: true, dereference: false });
    console.log(`${SCRIPT}: staged pack ${pack.classDir}/${meta.id}-${version}`);
  }
}

function stageDocs() {
  const src = path.join(repoRoot, 'docs', 'licenses.md');
  if (!fs.existsSync(src)) {
    fail(`required docs file missing: docs/licenses.md (the first-run licensing gate reads <resourcesPath>/docs/licenses.md)`);
    return;
  }
  copyFileSyncLoud(src, path.join(stageDir, 'docs', 'licenses.md'));
  console.log(`${SCRIPT}: staged docs/licenses.md`);
}

/** Copy web_ui/dist -> desktop/renderer, excluding staged weight (model-id)
 *  directories under dist/models/. Returns kept + skipped file counts. */
function copyRenderer() {
  if (!fs.existsSync(webUiDist)) {
    fail(`web_ui/dist is missing — run the web_ui build before staging (expected ${webUiDist})`);
    return;
  }
  rmSyncBestEffort(rendererDir);
  let kept = 0;
  let skipped = 0;
  const walk = (absSrc, relSrc) => {
    const entries = fs.readdirSync(absSrc, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = relSrc === '' ? entry.name : `${relSrc}/${entry.name}`;
      const childAbs = path.join(absSrc, entry.name);
      const segments = childRel.split('/');
      if (segments[0] === 'models' && segments.length >= 3 && entry.isDirectory()) {
        // models/<groupDir>/<modelId>/… — exclude when the model id is staged.
        const modelId = segments[2];
        if (RENDERER_EXCLUDED_MODEL_IDS.has(modelId)) {
          skipped += countFiles(childAbs);
          continue;
        }
      }
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        copyFileSyncLoud(childAbs, path.join(rendererDir, childRel));
        kept += 1;
      }
    }
  };
  walk(webUiDist, '');
  console.log(`${SCRIPT}: renderer copy complete (${kept} files kept, ${skipped} staged-weight files excluded)`);
  assertNoWeightOverlap();
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

/** Collect (modelId, fileName) pairs present under <root>/models/** — the
 *  model id is the directory under the group dir (models/<group>/<modelId>/…),
 *  NOT the file's immediate parent (different models share `onnx/` file
 *  names; keying on the parent would false-positive across models). */
function modelIdFilesUnder(root) {
  const modelsDir = path.join(root, 'models');
  const out = new Set();
  if (!fs.existsSync(modelsDir)) return out;
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) {
        // rel is models-root-relative: [<group>, <modelId>, …, <fileName>]
        const segments = childRel.split('/');
        if (segments.length >= 3) out.add(`${segments[1]}/${segments[segments.length - 1]}`);
      }
    }
  };
  walk(modelsDir, '');
  return out;
}

/** Double-ship guard: no (modelId, fileName) may exist in BOTH the renderer
 *  copy and the staged models tree (the ~4 GB breach this issue closes). */
function assertNoWeightOverlap() {
  const rendererFiles = modelIdFilesUnder(rendererDir);
  const stagedFiles = modelIdFilesUnder(stageDir);
  const overlap = [...rendererFiles].filter((key) => stagedFiles.has(key));
  if (overlap.length > 0) {
    for (const key of overlap.sort()) fail(`double-ship guard: ${key} exists in BOTH renderer/models and installer-resources/models`);
  } else {
    console.log(`${SCRIPT}: double-ship guard clean (no staged weight duplicated into renderer/models)`);
  }
}

function main() {
  rmSyncBestEffort(stageDir);
  fs.mkdirSync(stageDir, { recursive: true });
  stageModels();
  stagePacks();
  stageDocs();
  if (!args.skipRendererCopy) copyRenderer();
  if (args.fixtureModels) console.log('MODE: fixture-models');
  if (errors.length > 0) {
    for (const message of errors) console.error(`${SCRIPT}: FAIL ${message}`);
    console.error(`${SCRIPT}: staging FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log(`${SCRIPT}: staging complete -> ${path.relative(repoRoot, stageDir)}`);
}

// Run only when executed directly (not when imported by the specs).
if (process.argv[1] !== undefined && process.argv[1].endsWith('stage-installer-resources.mjs')) {
  main();
}
