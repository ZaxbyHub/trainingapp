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
 *      docs/licenses/LFM-OPEN-LICENSE-v1.0.txt
 *    The staged models are the ones the packaged DESKTOP runtime actually
 *    loads at base (verified in the trace's localization): the OnnxEmbedder's
 *    bge-small-en-v1.5 fp32 onnx/model.onnx (embedder.ts), the rerank
 *    worker's ettin-reranker-32m-v1 q8 onnx/model_quantized.onnx, and the
 *    ADR-0002 LLM GGUFs (as amended by #156). Explicit allow-lists — never a
 *    directory copy — so unselected leftovers on disk (the retired E2B qat
 *    tree, bge safetensors, model-Q4_K_M-old.gguf, fp32 variants) cannot
 *    ship. A missing required source file FAILS the build by name
 *    (electron-builder's extraResources would silently skip a missing from: —
 *    staging must not).
 *
 * 2. Copy web_ui/dist → desktop/renderer for desktop:build, EXCLUDING the
 *    weight files that are duplicated into installer-resources/models/. The
 *    two trees use different group coordinates (staged
 *    models/llm-quality/lfm2.5-2.6b vs renderer dist models/llm/
 *    lfm2-1.2b-rag), so the exclusion matches on the model-id directory
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
    id: 'lfm2.5-2.6b',
    label: 'LiquidAI LFM2.5-2.6B Q4_K_M (Quality LLM, ADR-0002 as amended by #156)',
    // No image adapter ships: node-llama-cpp has no image support, so only the
    // text GGUF is staged (#156; 1,674,455,040 bytes).
    files: ['model.gguf'],
  },
  {
    group: 'llm-fast',
    id: 'lfm2-1.2b-rag',
    label: 'LiquidAI LFM2-1.2B-RAG Q4_K_M (Fast LLM, ADR-0002 as amended by #156)',
    // Text GGUF only (#156; 730,894,048 bytes).
    files: ['model.gguf'],
  },
];

/** Renderer-copy exclusion key: model-id directories whose weights must not
 *  ALSO ship inside the packaged web_ui renderer copy. Exported for
 *  the committed cross-manifest parity spec (review PRR-132).
 *
 *  #156 DECOUPLED from STAGED_MODELS: this set is a PACKAGING decision — the
 *  desktop ships NO browser-LLM/embedder weights in the renderer copy (the
 *  native backend serves both roles from installer-resources/models) — not
 *  "whatever we stage". That is why the retired browser-LLM id STAYS listed
 *  although it is no longer staged (a renderer dist that still carries it
 *  would otherwise double-ship its weights), and why lfm2-1.2b-rag is listed:
 *  it is BOTH the browser fallback LLM and the staged fast model — the same
 *  bytes must not ship twice. Keep in lockstep with web_ui/.env.desktop's
 *  VITE_EXCLUDE_MODEL_GROUPS (group granularity) via the cross-manifest parity
 *  spec in e1-manifest-contract.test.ts. */
export const RENDERER_EXCLUDED_MODEL_IDS = new Set([
  'bge-small-en-v1.5',
  'ettin-reranker-32m-v1',
  'gemma-4-e2b-it',
  'lfm2.5-vl-450m',
  'lfm2-1.2b-rag',
]);

/** The staged pack set (issue #133). When the operator has built the initial
 *  knowledge pack from the local knowledgepack/ corpus
 *  (desktop/scripts/build-knowledge-pack.mjs → desktop/knowledge-pack-src/),
 *  it REPLACES the fixture as the staged content; otherwise (CI and
 *  weights-less checkouts) the minimal bundled-min fixture ships. #133 round 4
 *  added the BUNDLED Articulate course pack (build-training-pack.mjs → the
 *  same knowledge-pack-src/ root) as the Training tab's content, shipped with
 *  the installer exactly like the bundled documents; a half-built root (one
 *  pack without the other) fails the build via resolveStagedPacks. The
 *  fixture stays in contracts/fixtures/packs/ for the C-suite tests.
 *  knowledge-pack-src/ deliberately lives OUTSIDE stageDir: main() wipes
 *  installer-resources/ wholesale before staging. */
const KNOWLEDGE_PACK_SRC_ROOT = path.join(desktopDir, 'knowledge-pack-src');
// Fail loud on version skew: the builder accepts --version but this stager
// pins the expected dir name — a differently-versioned (or stale) pack dir
// must abort the build, never silently fall back to the fixture set.
function checkKnowledgePackSource() {
  if (!fs.existsSync(KNOWLEDGE_PACK_SRC_ROOT)) return;
  const dirs = fs
    .readdirSync(KNOWLEDGE_PACK_SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // opmed-cdp-mlc-* is the TRAINING pack — governed by
  // checkTrainingPackSource below, never a docs-pack mismatch.
  const unexpected = dirs.filter((name) => name !== 'opmed-initial-1.0.0' && !name.startsWith('opmed-cdp-mlc-'));
  if (unexpected.length > 0) {
    for (const name of unexpected) {
      fail(`unexpected pack dir desktop/knowledge-pack-src/${name} (this stager pins opmed-initial-1.0.0; rebuild with the pinned version or clear the dir — never silently stage a mismatched pack)`);
    }
  }
}
checkKnowledgePackSource();
// Real-build mode: docs pack + training pack (when the operator built them);
// a mismatched training-pack dir fails loud exactly like the docs one. CI and
// weights-less checkouts keep the fixture fallback (bundled-min only).
// 1.0.1 (#133 round 6): adds the publish's mobile/ player asset variants the
// 1.0.0 build dropped; the boot-ensure upgrades stores holding 1.0.0.
const TRAINING_PACK_VERSION = '1.0.1';
function checkTrainingPackSource() {
  const trainingRoot = path.join(desktopDir, 'knowledge-pack-src');
  if (!fs.existsSync(trainingRoot)) return;
  const unexpectedTraining = fs
    .readdirSync(trainingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('opmed-cdp-mlc') && name !== `opmed-cdp-mlc-${TRAINING_PACK_VERSION}`);
  for (const name of unexpectedTraining) {
    fail(`unexpected training pack dir desktop/knowledge-pack-src/${name} (this stager pins opmed-cdp-mlc-${TRAINING_PACK_VERSION}; rebuild with the pinned version or clear the dir — never silently stage a mismatched course)`);
  }
}
checkTrainingPackSource();
/**
 * The bundled-pack selection (#133 round 4/5). Real-content mode —
 * desktop/knowledge-pack-src/ EXISTS — requires BOTH packs: the docs pack AND
 * the Articulate course. A docs-only tree used to stage silently and ship an
 * installer with no Training content (round-5 review finding); now it fails
 * the build by name. The fixture fallback applies ONLY when the root is
 * absent entirely (CI, weights-less checkouts) — never as a half-built
 * escape hatch. Exported with injected roots so the committed spec can pin
 * every mode without machine-local state.
 */
export function resolveStagedPacks(opts) {
  const {
    knowledgePackSrcRoot,
    docsPackDir,
    trainingPackDir,
    fixturePackSource,
    onProblem = () => {},
  } = opts;
  if (!fs.existsSync(knowledgePackSrcRoot)) {
    return [{ source: fixturePackSource, classDir: 'bundled-docs' }];
  }
  const packs = [];
  const docsSource = path.join(knowledgePackSrcRoot, docsPackDir);
  const trainingSource = path.join(knowledgePackSrcRoot, trainingPackDir);
  const docsBuilt = fs.existsSync(path.join(docsSource, 'pack.json'));
  const trainingBuilt = fs.existsSync(path.join(trainingSource, 'pack.json'));
  if (docsBuilt) {
    packs.push({ source: docsSource, classDir: 'bundled-docs' });
  } else {
    onProblem(
      `docs pack missing: desktop/knowledge-pack-src/${docsPackDir}/pack.json not found ` +
        `(run node desktop/scripts/build-knowledge-pack.mjs, or remove desktop/knowledge-pack-src to stage the fixture set)`,
    );
  }
  if (trainingBuilt) {
    packs.push({ source: trainingSource, classDir: 'training' });
  } else {
    onProblem(
      `training pack missing: desktop/knowledge-pack-src/${trainingPackDir}/pack.json not found ` +
        `(run node desktop/scripts/build-training-pack.mjs — the installer must bundle the Articulate course alongside the documents; ` +
        `or remove desktop/knowledge-pack-src to stage the fixture set)`,
    );
  }
  return packs;
}
const STAGED_PACKS = resolveStagedPacks({
  knowledgePackSrcRoot: KNOWLEDGE_PACK_SRC_ROOT,
  docsPackDir: 'opmed-initial-1.0.0',
  trainingPackDir: `opmed-cdp-mlc-${TRAINING_PACK_VERSION}`,
  fixturePackSource: path.join(repoRoot, 'contracts', 'fixtures', 'packs', 'bundled-min'),
  onProblem: fail,
});

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

/** Missing-source detector for the staged allow-list (review PRR-115): the
 *  sole allow-list-vs-disk guard in real-weights mode. Exported so the
 *  committed specs can exercise it; the stager calls it before copying. */
export function findMissingSources(repoRoot, stagedModels = STAGED_MODELS) {
  const missing = [];
  for (const model of stagedModels) {
    for (const rel of model.files) {
      const src = path.join(repoRoot, 'models', model.id, rel);
      if (!fs.existsSync(src)) missing.push(path.join('models', model.id, rel));
    }
  }
  return missing;
}

function stageModels() {
  // The allow-list-vs-disk guard is REAL-WEIGHTS-MODE ONLY (review round 2):
  // fixture mode derives the tree from the table itself and must stay green
  // on weights-less checkouts (CI) — checking disk there broke --fixture-models.
  const missing = args.fixtureModels ? [] : findMissingSources(repoRoot);
  for (const rel of missing) {
    fail(`required model file missing: ${rel} (stage it per PACKAGING.md, or pass --fixture-models for CI)`);
  }
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
        continue; // already reported by findMissingSources above
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
  // Issue #84 licensing: the first-run wizard reads <resources>/docs/licenses.md.
  // #156 adds the full verbatim LFM Open License v1.0 text (both bundled LLM
  // tiers are LFM-licensed; the summary alone is not the license).
  const docsFiles = ['docs/licenses.md', 'docs/licenses/LFM-OPEN-LICENSE-v1.0.txt'];
  for (const rel of docsFiles) {
    const src = path.join(repoRoot, ...rel.split('/'));
    if (!fs.existsSync(src)) {
      fail(`required docs file missing: ${rel} (the first-run licensing gate reads <resourcesPath>/docs/licenses.md; the LFM license text must ship beside it)`);
      continue;
    }
    copyFileSyncLoud(src, path.join(stageDir, ...rel.split('/')));
    console.log(`${SCRIPT}: staged ${rel}`);
  }
}

/** Contract files the PACKAGED app must resolve from inside app.asar
 *  (issue #133): openStore and PackManager both walk up from the compiled
 *  dist/main/backend/store module looking for contracts/… — on a clean
 *  install nothing outside the asar exists. Staged under desktop/dist/
 *  contracts/ so the existing electron-builder "dist" files glob carries
 *  them into the asar (and into reach of the walk); nothing lands in the
 *  resources manifest tree, whose generator rejects unknown roots.
 *  Byte-copies, so a stale copy can never drift from the repo contract
 *  files at build time. Exported for the committed spec
 *  (e133-stager-contracts.test.ts). */
export const STAGED_CONTRACTS = ['contracts/store.schema.sql', 'contracts/pack.schema.json', 'contracts/pack-feed.schema.json'];

export function stageContracts(targetDesktopDir = desktopDir) {
  for (const rel of STAGED_CONTRACTS) {
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) {
      fail(`required contract file missing: ${rel} (the packaged findRepoRoot walk reads dist/contracts — issue #133)`);
      continue;
    }
    copyFileSyncLoud(src, path.join(targetDesktopDir, 'dist', rel));
  }
  console.log(`${SCRIPT}: staged ${STAGED_CONTRACTS.length} contract files into ${path.relative(repoRoot, path.join(targetDesktopDir, 'dist', 'contracts'))}/`);
}

/** Newest mtime (ms) under `dir`, or 0 when it holds no readable file.
 *
 *  Bounded two ways so it stays cheap on a real-weights tree: `dist/models/`
 *  is excluded because copyRenderer() excludes it too (comparing against a
 *  staged multi-GB weight directory would both be slow and describe something
 *  the renderer never contained), and the walk stops after MAX_FRESHNESS_FILES
 *  files, which is far more than any renderer needs to establish a verdict.
 *  A truncated walk can only under-report NEWEST, so it can never invent a
 *  staleness failure that is not real. */
const FRESHNESS_EXCLUDED = new Set(['models']);
const MAX_FRESHNESS_FILES = 5000;
function newestMtimeMs(dir) {
  let newest = 0;
  let seen = 0;
  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!FRESHNESS_EXCLUDED.has(entry.name)) walk(path.join(abs, entry.name));
        continue;
      }
      try {
        const mtimeMs = fs.statSync(path.join(abs, entry.name)).mtimeMs;
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        // Raced away between readdir and stat; a file we cannot stat cannot
        // make the renderer look fresher, so skipping it is the safe direction.
      }
      if (++seen >= MAX_FRESHNESS_FILES) return;
    }
  };
  walk(dir);
  return newest;
}

/**
 * Is desktop/renderer missing or stale with respect to web_ui/dist? Returns a
 * named problem string, or null when the renderer is usable (issue #173 AC1).
 *
 * PLACEMENT IS THE FIX, and it is why this lives here rather than inside
 * copyRenderer(). `desktop/package.json`'s `build` invokes this script with
 * --skip-renderer-copy, so copyRenderer() — and the missing-dist guard inside
 * it — never ran on the very path that produces the footgun. The build then
 * succeeded silently and packaged whatever renderer happened to be on disk,
 * possibly one many builds old. A guard that only executes on the path the
 * mistake avoids is not a guard.
 *
 * STALENESS, not merely ABSENCE: this compares the newest mtime under
 * web_ui/dist against the newest under desktop/renderer, so a renderer that is
 * present but predates the current dist is caught. Absence-only detection would
 * wave through "present but three builds old", which is the more dangerous half
 * — it ships a working-looking installer whose UI does not match the tree.
 *
 * Returns null when there is nothing to compare against (no web_ui/dist), so a
 * machine that only ever builds the desktop bundle is not forced into a web_ui
 * build it has no reason to run.
 */
export function rendererFreshnessProblem({
  skipRendererCopy,
  rendererDir: renderer = rendererDir,
  webUiDist: dist = webUiDist,
  repoRoot: root = repoRoot,
} = {}) {
  // Without the flag, copyRenderer() is about to create the renderer wholesale;
  // absence and staleness are both about to be resolved, so nothing to report.
  if (!skipRendererCopy) return null;

  const relRenderer = path.relative(root, renderer);
  if (!fs.existsSync(renderer)) {
    return (
      `--skip-renderer-copy was passed but ${relRenderer} does not exist, so this build would ` +
      'package no renderer at all. Run "npm --prefix desktop run desktop:build" to build the ' +
      'web app and stage it, or drop --skip-renderer-copy.'
    );
  }
  if (!fs.existsSync(dist)) return null;

  const distNewest = newestMtimeMs(dist);
  const rendererNewest = newestMtimeMs(renderer);
  if (distNewest <= rendererNewest) return null;

  const distRel = path.relative(root, dist);
  return (
    `${relRenderer} is STALE: ${distRel} contains a file newer than every file in the ` +
    'renderer, so this build would package a renderer that predates the current web app. ' +
    'Run "npm --prefix desktop run desktop:build", or re-stage the renderer without ' +
    '--skip-renderer-copy.'
  );
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
      } else {
        // Fail loud (mirrors the generator's walk): a symlink/FIFO in the
        // dist tree must never silently vanish from the packaged renderer.
        fail(`renderer dist contains a non-file/non-directory entry (excluded from the copy): ${childRel}`);
      }
    }
  };
  walk(webUiDist, '');
  console.log(`${SCRIPT}: renderer copy complete (${kept} files kept, ${skipped} staged-weight files excluded)`);
  reconcileRendererManifest(rendererDir, RENDERER_EXCLUDED_MODEL_IDS);
  if (args.fixtureModels) {
    // Fixture builds (CI) run without prepare-models, so the renderer copy
    // has no weight files for the completeness guard to check — the guard is
    // real-weights-mode only, same gating philosophy as findMissingSources.
    console.log(`${SCRIPT}: renderer manifest completeness skipped in fixture mode (weights are operator-acquired)`);
  } else {
    assertRendererManifestComplete(rendererDir);
  }
  assertNoWeightOverlap();
}

/** Rewrite the COPIED renderer manifest (renderer/models/manifest.json) so it
 *  no longer declares the weight entries this stager excludes. Without this,
 *  the packaged renderer's readiness gate (checkPackagedModels) reports
 *  "required model file(s) not found" for files that are staged and
 *  gate-verified one directory over (review PRR-132). Non-excluded entries
 *  (ort, wllama, the browser embedder) pass through untouched. Exported for
 *  the committed cross-manifest parity spec. */
export function reconcileRendererManifest(rendererRoot, excludedIds) {
  const manifestPath = path.join(rendererRoot, 'models', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`renderer manifest missing after the copy: ${manifestPath}`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`renderer manifest unreadable at ${manifestPath}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!Array.isArray(manifest.models)) {
    fail(`renderer manifest at ${manifestPath} has no models[] array`);
    return;
  }
  const dropped = [];
  const kept = [];
  for (const entry of manifest.models) {
    if (excludedIds.has(entry.id)) {
      dropped.push(entry.id);
    } else {
      kept.push(entry);
    }
  }
  manifest.models = kept;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `${SCRIPT}: renderer manifest reconciled (${kept.length} entries kept` +
      (dropped.length > 0 ? `; dropped staged-weight entries: ${dropped.join(', ')}` : '') +
      ')',
  );
}

/** Over-exclusion detector (the two-sided half of the double-ship guard):
 *  after reconciliation, EVERY remaining required file in the renderer
 *  manifest must exist under the renderer copy. A future staged model id
 *  that collides with a renderer-required id would otherwise silently strip
 *  renderer weights while every guard stays green (review PRR-132). */
function assertRendererManifestComplete(rendererRoot) {
  const manifestPath = path.join(rendererRoot, 'models', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return; // reconcile already reported the unreadable/unshaped manifest
  }
  if (!Array.isArray(manifest.models)) return; // same: reconcile reported it
  const missing = [];
  for (const entry of manifest.models) {
    for (const file of entry.files ?? []) {
      if (file.required === false) continue;
      const abs = path.join(rendererRoot, 'models', file.path);
      if (!fs.existsSync(abs)) missing.push(`${entry.id}: ${file.path}`);
    }
  }
  if (missing.length > 0) {
    for (const item of missing) fail(`renderer manifest completeness: required file missing from the renderer copy: ${item}`);
  } else {
    console.log(`${SCRIPT}: renderer manifest completeness clean (every remaining required file present)`);
  }
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
  stageContracts();
  // issue #173 AC1: evaluated on EVERY invocation and BEFORE the
  // --skip-renderer-copy branch below. `build` passes that flag, so a check
  // placed inside the copy path would never run on the path that needs it.
  const freshnessProblem = rendererFreshnessProblem({
    skipRendererCopy: args.skipRendererCopy,
  });
  if (freshnessProblem !== null) fail(freshnessProblem);
  if (!args.skipRendererCopy) copyRenderer();
  if (args.fixtureModels) console.log('MODE: fixture-models');
  if (errors.length > 0) {
    for (const message of errors) console.error(`${SCRIPT}: FAIL ${message}`);
    console.error(`${SCRIPT}: staging FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log(`${SCRIPT}: staging complete -> ${path.relative(repoRoot, stageDir)}`);
}

// Run only when executed directly (not when imported by the specs). Case
// folded: Windows filesystems are case-insensitive, so a case-varied
// invocation path must still count as a direct run (review PRR-122).
if (
  process.argv[1] !== undefined &&
  process.argv[1].toLowerCase().endsWith('stage-installer-resources.mjs')
) {
  main();
}
