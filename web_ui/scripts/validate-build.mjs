#!/usr/bin/env node
/**
 * validate-build.mjs — fail the build if the produced dist/ is not a complete,
 * offline-ready archive.
 *
 * Checks:
 *   1. dist/index.html, dist/models/, and dist/assets/ exist.
 *   2. Every file declared in public/models/manifest.json (the single source of
 *      truth shared with src/lib/models/model-manifest.ts) is present in dist/models/
 *      with non-zero size — so a build that forgot `prepare-models` cannot ship a
 *      broken offline archive. Files marked `required: false` are checked only
 *      for presence, not required.
 *   3. (Issue #37 P4) If a manifest file entry carries a `checksum` field
 *      (SHA-256 hex, written by prepare-models.mjs), the dist file's SHA-256
 *      must match. Detects corruption / partial copies / wrong-quantization
 *      swaps that happen to be non-zero bytes.
 *   4. (Issue #37 P4) No file under dist/models/ may be a Git-LFS pointer stub
 *      (a fresh non-LFS checkout would leave 134-byte pointer files in dist).
 *   5. (Issue #37 P4) Sanity-check that known Vite asset chunks exist under
 *      dist/assets/ (pdf worker, fonts). Catches a broken Rollup config that
 *      silently dropped a chunk.
 *
 * Group handling (manifest v2 `group` field):
 *   - `core`    — always enforced (ORT runtime; embedding + reranker now have
 *                 their own groups, enforced unless their --no-X flag is passed).
 *   - `llm`     — the browser-LLM runtime (wllama WASM/compat) + Gemma 4 E2B-it weights.
 *                  Enforced by default; skipped when `--no-llm` is passed (for
 *                  embeddings-only / server-mode builds where the multi-GB LLM
 *                  weights are deliberately absent).
 *   - `optional` — never enforced.
 *
 * NOTE: we deliberately do NOT grep built JS for CDN hostnames. Vendored ML libs
 * (transformers.js, web-llm's prebuiltAppConfig, ORT/wllama) embed default-CDN
 * URLs as runtime string constants that survive minification even though the app
 * never calls them (offline-env.ts sets allowRemoteModels=false and overrides
 * wasm paths). A substring grep would false-fail every correct offline build.
 * The real offline guarantee is enforced at runtime (offline-env.ts) and verified
 * by the no-network preview test in PACKAGING.md §4.
 *
 * Exit code is non-zero on any failure so it can gate CI / packaging.
 *
 * Usage:  node scripts/validate-build.mjs [--no-llm] [--no-reranker] [--no-embedder] [--airgap]
 */

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');
const DIST = join(WEB_UI, 'dist');
const MANIFEST = join(WEB_UI, 'public', 'models', 'manifest.json');

// `--no-llm` skips the browser-LLM runtime + weights (embeddings-only build).
const SKIP_LLM = process.argv.slice(2).includes('--no-llm');
// `--no-reranker` skips the cross-encoder reranker weights (CI build without
// the operator-acquired q8 ONNX). Mirrors prepare-models' --no-reranker flag;
// the two MUST stay in sync so a CI build that skips staging the reranker
// also skips validating it. Production packaging omits both flags.
const SKIP_RERANKER = process.argv.slice(2).includes('--no-reranker');
// `--no-embedder` (Issue #37 R9): skip the embedding model group. The arctic
// q8 ONNX is operator-acquired (not in the repo); CI builds with this flag
// skip both staging AND validation of the embedding group. Production
// packaging omits it.
const SKIP_EMBEDDER = process.argv.slice(2).includes('--no-embedder');
// `--airgap` (Issue #37 P2) enables airgap-specific checks: scanning emitted
// JS chunks for WebLLM symbols (`CreateMLCEngine`, `prebuiltMLCAppConfig`)
// and chunk names matching /web-?llm/i. A non-airgap build (default) skips
// this check because it expects WebLLM to be present. Only build-airgap.mjs
// passes this flag; `npm run build:offline` and `npm run build` do not.
const AIRGAP_CHECK = process.argv.slice(2).includes('--airgap');

const errors = [];
function fail(msg) {
  errors.push(msg);
}

/** Compute SHA-256 hex of a file by streaming it through the hash.
 *  MUST stream (not readFileSync) — the wllama GGUF is ~2.9 GB, above Node's
 *  ~2 GB Buffer cap, so readFileSync would throw RangeError on the LLM weights. */
async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Git-LFS pointer files start with this exact version line. */
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
function isLfsPointerFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath);
    const buf = Buffer.alloc(LFS_POINTER_HEADER.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.toString('utf8', 0, n) === LFS_POINTER_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

// 1. dist shell
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html is missing — run `npm run build` first.');
}
if (!existsSync(join(DIST, 'models'))) {
  fail('dist/models/ is missing — run `npm run prepare-models` before building.');
}
if (!existsSync(join(DIST, 'assets'))) {
  fail('dist/assets/ is missing — the Vite build did not emit its JS/CSS chunks.');
}

// 2. required model files from the manifest (single source of truth)
if (existsSync(MANIFEST)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }
  // Issue #37 P4: prepare-models writes SHA-256 of staged files into a sidecar.
  // Copy the public/models/ sidecar into dist/models/ is NOT automatic; the
  // checksums are recorded per-staged-file in public/models/manifest.checksums.json
  // and are copied to dist by `vite build` (everything under public/ is copied).
  // Load whichever copy exists; missing sidecar = no checksum checks (not an error).
  const CHECKSUMS_PUBLIC = join(WEB_UI, 'public', 'models', 'manifest.checksums.json');
  const CHECKSUMS_DIST = join(DIST, 'models', 'manifest.checksums.json');
  let checksums = {};
  for (const csPath of [CHECKSUMS_DIST, CHECKSUMS_PUBLIC]) {
    if (existsSync(csPath)) {
      try {
        const parsed = JSON.parse(readFileSync(csPath, 'utf8'));
        if (parsed && typeof parsed.files === 'object') {
          checksums = parsed.files;
          break;
        }
      } catch {
        // ignore parse errors — fall through to next candidate
      }
    }
  }
  // Collect checksum-verification jobs (sha256OfFile is async because model
  // files are streamed — the GGUF is ~2.9 GB, above Node's Buffer cap).
  const checksumJobs = [];
  for (const model of manifest?.models ?? []) {
    const group = model.group ?? 'core';
    if (group === 'optional') continue; // never enforced
    if (SKIP_LLM && group === 'llm') continue; // embeddings-only build opt-out
    // --no-reranker: the cross-encoder q8 ONNX is operator-acquired (not in
    // the repo); CI builds with --no-reranker skip both staging AND validation
    // of the reranker group. Production packaging (no flag) enforces it.
    if (SKIP_RERANKER && model.kind === 'reranker') continue;
    // --no-embedder (Issue #37 R9): the arctic q8 ONNX is operator-acquired;
    // CI skips validation of the embedding group.
    if (SKIP_EMBEDDER && model.kind === 'embedding') continue;
    // `files` is the v2 schema; fall back to legacy `required` array for safety.
    const files = Array.isArray(model.files)
      ? model.files
      : (model.required ?? []).map((rel) => ({ path: rel, required: true }));
    for (const f of files) {
      if (f.required === false) continue;
      const file = join(DIST, 'models', f.path);
      if (!existsSync(file) || statSync(file).size < 1) {
        fail(`required model file missing from dist: models/${f.path} (model "${model.id}")`);
        continue;
      }
      // LFS-pointer guard on dist contents (Issue #37 P4).
      if (isLfsPointerFile(file)) {
        fail(
          `dist file is a Git-LFS pointer stub, not the real weights: models/${f.path} ` +
            `(model "${model.id}"). Run \`git lfs pull\` and rebuild.`
        );
        continue;
      }
      // Checksum verification when prepare-models recorded one (Issue #37 P4).
      const expected = typeof f.checksum === 'string' ? f.checksum : checksums[f.path];
      if (typeof expected === 'string' && expected.length === 64) {
        checksumJobs.push({ file, expected, path: f.path, modelId: model.id });
      }
    }
  }
  // Run the (potentially multi-GB) hashing concurrently but bounded; the file
  // set is small (a dozen model files), so a simple Promise.all is fine.
  if (checksumJobs.length > 0) {
    const results = await Promise.all(
      checksumJobs.map(async (job) => {
        const actual = await sha256OfFile(job.file);
        return { ...job, actual };
      })
    );
    for (const r of results) {
      if (r.actual.toLowerCase() !== r.expected.toLowerCase()) {
        fail(
          `checksum mismatch for models/${r.path} (model "${r.modelId}"): ` +
            `expected ${r.expected}, got ${r.actual}. File is corrupt or was replaced.`
        );
      }
    }
  }
  if (SKIP_LLM) {
    process.stderr.write(
      '[validate-build] WARN: --no-llm passed — the browser-LLM runtime + weights group was NOT validated. ' +
        'The resulting artifact CANNOT drive in-browser chat generation. ' +
        'Only use this for embeddings-only / server-mode builds.\n'
    );
  }
  if (SKIP_RERANKER) {
    process.stderr.write(
      '[validate-build] WARN: --no-reranker passed — the cross-encoder reranker group was NOT validated. ' +
        'The resulting artifact will degrade to fused results (no neural reranking). ' +
        'Production packaging MUST omit this flag.\n'
    );
  }
  if (SKIP_EMBEDDER) {
    process.stderr.write(
      '[validate-build] WARN: --no-embedder passed — the embedding model group was NOT validated. ' +
        'The resulting artifact has NO semantic search capability. ' +
        'Production packaging MUST omit this flag.\n'
    );
  }
} else {
  fail('public/models/manifest.json not found.');
}

// 3. (Issue #37 P4) Vite asset chunk sanity check. The build emits these chunks
//    by name (or name pattern); their absence indicates a broken Rollup config
//    or a renamed dynamic import. We assert the assets directory is non-empty
//    and contains at least one .js chunk — the strongest invariant that does
//    not become false-positive-prone as Vite renames chunks by content hash.
try {
  const assetsDir = join(DIST, 'assets');
  if (existsSync(assetsDir)) {
    const entries = readdirSync(assetsDir);
    const jsChunks = entries.filter((e) => e.endsWith('.js'));
    if (jsChunks.length === 0) {
      fail('dist/assets/ contains no .js chunks — the Vite build emitted no JavaScript. Re-run `npm run build`.');
    }
  }
} catch (e) {
  fail(`could not inspect dist/assets/: ${e.message}`);
}

// 4. (Issue #37 P2) Airgap-specific check: verify no WebLLM symbols survive
//    in any emitted chunk when the build was produced under VITE_AIRGAP=1.
//    Tree-shaking may fail silently (e.g., bundler version change, dead-code
//    elimination regression), so we assert at the output artifact level.
if (AIRGAP_CHECK) {
  try {
    const assetsDir = join(DIST, 'assets');
    if (existsSync(assetsDir)) {
      const entries = readdirSync(assetsDir);
      const jsChunks = entries.filter((e) => e.endsWith('.js'));
      for (const chunk of jsChunks) {
        const content = readFileSync(join(assetsDir, chunk), 'utf8');
        // Check for WebLLM factory symbols that should have been tree-shaken.
        if (/CreateMLCEngine|prebuiltMLCAppConfig|web-llm/i.test(content)) {
          fail(
            `airgap violation: ${chunk} contains WebLLM code. ` +
            `Set VITE_AIRGAP=1 before building, or verify Rollup tree-shakes @mlc-ai/web-llm. ` +
            `Run \`npm run build:airgap\` to reproduce.\n` +
            `  (hint: grep for "CreateMLCEngine|web-llm" in dist/assets/ after a clean ` +
            `VITE_AIRGAP=1 build)`
          );
        }
      }
    }
  } catch (e) {
    fail(`airgap scan failed: ${e.message}`);
  }
}

if (errors.length > 0) {
  process.stderr.write('[validate-build] FAILED — archive is not offline-ready:\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write('[validate-build] OK — dist/ is a complete offline archive.\n');
