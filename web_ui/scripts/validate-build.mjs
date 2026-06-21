#!/usr/bin/env node
/**
 * validate-build.mjs — fail the build if the produced dist/ is not a complete,
 * offline-ready archive.
 *
 * Checks:
 *   1. dist/index.html and dist/models/ exist.
 *   2. Every REQUIRED file declared in public/models/manifest.json is present in
 *      dist/models/ (so a build that forgot `prepare-models` cannot ship a broken
 *      offline archive).
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
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');
const DIST = join(WEB_UI, 'dist');
const MANIFEST = join(WEB_UI, 'public', 'models', 'manifest.json');

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

// 2. required model files from the manifest
if (existsSync(MANIFEST)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }
  for (const model of manifest?.models ?? []) {
    for (const rel of model.required ?? []) {
      const f = join(DIST, 'models', rel);
      if (!existsSync(f) || statSync(f).size < 1) {
        fail(`required model file missing from dist: models/${rel} (model "${model.id}")`);
      }
    }
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
