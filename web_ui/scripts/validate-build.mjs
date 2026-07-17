#!/usr/bin/env node
/**
 * validate-build.mjs — fail the build if the produced dist/ is not a complete,
 * offline-ready archive.
 *
 * Checks:
 *   1. dist/index.html and dist/models/ exist.
 *   2. Every file declared in public/models/manifest.json (the single source of
 *      truth shared with src/lib/models/model-manifest.ts) is present in dist/models/
 *      with non-zero size — so a build that forgot `prepare-models` cannot ship a
 *      broken offline archive. Files marked `required: false` (the optional
 *      reranker) are checked only for presence, not required.
 *
 * Group handling (manifest v2 `group` field):
 *   - `core`    — always enforced (embedding + ORT runtime).
 *   - `llm`     — the browser-LLM runtime (wllama WASM/compat) + Gemma 4 E2B-it weights.
 *                  Enforced by default; skipped when `--no-llm` is passed (for
 *                  embeddings-only / server-mode builds where the multi-GB LLM
 *                  weights are deliberately absent).
 *   - `optional` — never enforced (e.g. the optional reranker).
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
 * Usage:  node scripts/validate-build.mjs [--no-llm]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');
const DIST = join(WEB_UI, 'dist');
const MANIFEST = join(WEB_UI, 'public', 'models', 'manifest.json');

// `--no-llm` skips the browser-LLM runtime + weights (embeddings-only build).
const SKIP_LLM = process.argv.slice(2).includes('--no-llm');

const errors = [];
function fail(msg) {
  errors.push(msg);
}

// 1. dist shell
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html is missing — run `npm run build` first.');
}
if (!existsSync(join(DIST, 'models'))) {
  fail('dist/models/ is missing — run `npm run prepare-models` before building.');
}

// 2. required model files from the manifest (single source of truth)
if (existsSync(MANIFEST)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }
  for (const model of manifest?.models ?? []) {
    const group = model.group ?? 'core';
    if (group === 'optional') continue; // never enforced
    if (SKIP_LLM && group === 'llm') continue; // embeddings-only build opt-out
    // `files` is the v2 schema; fall back to legacy `required` array for safety.
    const files = Array.isArray(model.files)
      ? model.files
      : (model.required ?? []).map((rel) => ({ path: rel, required: true }));
    for (const f of files) {
      if (f.required === false) continue;
      const file = join(DIST, 'models', f.path);
      if (!existsSync(file) || statSync(file).size < 1) {
        fail(`required model file missing from dist: models/${f.path} (model "${model.id}")`);
      }
    }
  }
  if (SKIP_LLM) {
    process.stdout.write('[validate-build] --no-llm: skipping browser-LLM runtime + weights group.\n');
  }
} else {
  fail('public/models/manifest.json not found.');
}

if (errors.length > 0) {
  process.stderr.write('[validate-build] FAILED — archive is not offline-ready:\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write('[validate-build] OK — dist/ is a complete offline archive.\n');
