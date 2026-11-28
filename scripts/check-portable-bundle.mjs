#!/usr/bin/env node
/**
 * Fail-closed completeness gate for a testers release bundle.
 *
 * Usage: node scripts/check-portable-bundle.mjs <win-unpacked-dir> [--verify-hashes]
 *
 * Verifies that a packaged desktop tree really carries everything needed to
 * run the application fully offline: executable, asar, renderer entrypoint,
 * the manifest's entire model/pack resource set with exact byte sizes, at
 * least four real model groups and both knowledge packs (issue: testers
 * releases MUST contain the full offline application, not a CI ZIP).
 * --verify-hashes additionally checks every manifest sha256 (slow: ~3 GB).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const verifyHashes = args.includes('--verify-hashes');

if (!root || !fs.existsSync(root)) {
  console.error(`check-portable-bundle: missing or invalid bundle directory: ${root ?? '(none)'}`);
  console.error('usage: node scripts/check-portable-bundle.mjs <win-unpacked-dir> [--verify-hashes]');
  process.exit(2);
}

const failures = [];
const check = (rel, predicate, detail) => {
  if (!predicate()) failures.push(`${rel}: ${detail}`);
};

const topLevel = ['TrainingApp.exe', 'resources/app.asar', 'resources/web_ui/index.html', 'resources/manifest.json'];
for (const rel of topLevel) {
  check(rel, () => fs.existsSync(path.join(root, rel)), 'required file missing');
}

const manifestPath = path.join(root, 'resources', 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('check-portable-bundle: FAIL — resources/manifest.json missing; cannot verify offline payload');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const models = Array.isArray(manifest.models) ? manifest.models : [];
const packs = Array.isArray(manifest.packs) ? manifest.packs : [];
check('models groups', () => models.length >= 4, `expected >= 4 real model groups, found ${models.length}`);
check('packs', () => packs.length >= 2, `expected both knowledge packs, found ${packs.length}`);

const groups = new Set(models.map((m) => m.group ?? m.kind));
for (const group of ['embedding', 'reranker', 'llm-quality', 'llm-fast']) {
  check(`models/${group}`, () => groups.has(group), 'required model group absent from manifest');
}

const entries = [...models, ...packs].flatMap((group) => (group.files ?? []).map((f) => ({ ...f, group: group.id ?? group.dir })));
for (const entry of entries) {
  if (!entry.path) continue;
  const file = path.join(root, 'resources', entry.path);
  if (!fs.existsSync(file)) {
    failures.push(`${entry.path}: payload file missing`);
    continue;
  }
  if (Number.isFinite(entry.sizeBytes)) {
    const actual = fs.statSync(file).size;
    check(entry.path, () => actual === entry.sizeBytes, `size ${actual} != manifest ${entry.sizeBytes}`);
  }
  if (verifyHashes && typeof entry.sha256 === 'string') {
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(file));
    check(entry.path, () => hash.digest('hex') === entry.sha256, 'sha256 mismatch');
  }
}

// A 1024-byte stub GGUF was a recorded release failure; name it explicitly.
for (const rel of [
  'models/llm-quality/lfm2.5-2.6b/model.gguf',
  'models/llm-fast/lfm2-1.2b-rag/model.gguf',
]) {
  const file = path.join(root, 'resources', rel);
  if (!fs.existsSync(file)) continue;
  const size = fs.statSync(file).size;
  check(rel, () => size > 100 * 1024 * 1024, `suspicious ${size}-byte model file (stub/fixture?)`);
}

if (failures.length) {
  console.error(`check-portable-bundle: FAIL (${failures.length} problems)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check-portable-bundle: OK — ${entries.length} manifest files, ${models.length} model groups, ${packs.length} packs${verifyHashes ? ' (hashes verified)' : ''}`);
