#!/usr/bin/env node
/**
 * build-installer-manifest.mjs — E1 (issue #84) installer resources manifest
 * generator + completeness gate.
 *
 * Walks a staged resources tree (assembled by stage-installer-resources.mjs:
 * models/<group>/<id>/…, packs/<classDir>/<packId>-<version>/…, docs/) and
 * writes a resources/manifest.json in the shape the E2 verifier consumes
 * (desktop/main/first-run/manifest-verifier.ts):
 *   { version, description, models: [{id,label,kind,group,files:[{path,
 *     required,sha256,sizeBytes}]}], packs: [{id,version,name,source_class,
 *     dir, files:[{path,sha256,sizeBytes}]}] }
 *
 * Contract pins (issue-tracer trace 84-package-models-integrity-manifest):
 * - Manifest file paths are STAGE-ROOT-relative with forward slashes. In the
 *   packaged layout the manifest sits at the resources root, so stage-root ==
 *   manifest dir and verifyManifest's roots resolve them.
 * - Whole-tree enumeration: every staged file is listed (the docs tree gets a
 *   models[] entry with kind 'docs'; pack files are enumerated WITHOUT
 *   required:true because the E2 verifier iterates models[] only — pack
 *   integrity is enforced at build (this script's --verify) and at install
 *   (the #68 pack schema's per-doc sha256 via the PackManager)).
 * - The completeness walk exempts the manifest itself at --out (resolved):
 *   a manifest cannot hash itself.
 * - --verify is READ-ONLY: it compares the staged tree against the manifest
 *   at --out and never regenerates — a file planted after generation stays
 *   unlisted and fails the gate.
 * - Tree-driven emission: entries derive from what the walk finds (docs entry
 *   only when docs/ exists; pack entries only for pack dirs found). pack.json
 *   parsing is tolerant (id+version required; name/source_class optional) and
 *   NO pack-schema validation happens here — pack-schema conformance is
 *   packtool's job at install time.
 * - Hashing STREAMS in chunks: the quality GGUF is 2.6 GB, above what
 *   readFileSync-based hashing should ever allocate.
 *
 * Usage:
 *   node desktop/scripts/build-installer-manifest.mjs --stage-dir <dir> [--out <path>] [--note <text>]
 *   node desktop/scripts/build-installer-manifest.mjs --stage-dir <dir> --out <path> --verify
 * (--stage is accepted as an alias of --stage-dir; the stage dir may also be
 *  passed positionally. --out defaults to <stage>/manifest.json.)
 * Exit code non-zero on any failure.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'build-installer-manifest';
const CHUNK_BYTES = 8 * 1024 * 1024;

const errors = [];
function fail(message) {
  errors.push(`${message}`);
}

function usage() {
  return [
    `usage: node desktop/scripts/${SCRIPT}.mjs --stage-dir <dir> [--out <path>] [--note <text>]`,
    `       node desktop/scripts/${SCRIPT}.mjs --stage-dir <dir> --out <path> --verify`,
    '',
    '  --stage-dir <dir>  staged resources tree (alias: --stage; positional accepted)',
    '  --out <path>       manifest output path (default <stage>/manifest.json)',
    '  --note <text>      appended to the manifest description (e.g. "MODE: fixture-models")',
    '  --verify           read-only completeness + integrity check; never regenerates',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { stage: undefined, out: undefined, note: undefined, verify: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--stage-dir' || arg === '--stage') out.stage = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--note') out.note = next();
    else if (arg === '--verify' || arg === '--check') out.verify = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-') && out.stage === undefined) out.stage = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  // CI passes the mode through the environment because the npm script chain
  // (desktop:build) cannot forward flags.
  if (out.note === undefined && process.env.TRAININGAPP_INSTALLER_MANIFEST_NOTE !== undefined) {
    out.note = process.env.TRAININGAPP_INSTALLER_MANIFEST_NOTE;
  }
  return out;
}

async function sha256File(absolutePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(absolutePath, { highWaterMark: CHUNK_BYTES });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/** Forward-slash stage-root-relative path for a file under `stageRoot`. */
function toRel(stageRoot, absolutePath) {
  const rel = path.relative(stageRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

/** Recursive file walk (relative, forward-slash). Symlinks are refused. */
async function walkFiles(root, relDir = '') {
  const out = [];
  const absDir = relDir === '' ? root : path.join(root, relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      fail(`staged tree must not contain symlinks (found ${rel})`);
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      fail(`staged tree must contain only files and directories (found ${rel})`);
    }
  }
  return out;
}

const MODEL_GROUPS = new Set(['embedding', 'reranker', 'llm-quality', 'llm-fast']);
const CLASS_SOURCE_CLASS = new Map([
  ['bundled-docs', 'bundled'],
  ['training', 'training'],
]);

/** Read pack.json tolerantly: id+version required, name/source_class optional. */
async function readPackMeta(packDirAbs) {
  const metaPath = path.join(packDirAbs, 'pack.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  } catch (err) {
    fail(`pack dir ${toRel(stage, packDirAbs)} has no readable pack.json (${err instanceof Error ? err.message : err})`);
    return null;
  }
  if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string' || raw.id.length === 0) {
    fail(`pack dir ${toRel(stage, packDirAbs)}: pack.json id is required`);
    return null;
  }
  return {
    id: raw.id,
    version: raw.version !== undefined ? String(raw.version) : '1.0.0',
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
    source_class: typeof raw.source_class === 'string' && raw.source_class.length > 0 ? raw.source_class : undefined,
  };
}

let stage; // resolved stage root, used by toRel inside helpers

async function buildManifest(stageRoot, outPath, note) {
  const files = await walkFiles(stageRoot);
  if (files.length === 0) fail('staged tree is empty — nothing to enumerate');
  const outAbs = path.resolve(outPath);
  const outRel = path.relative(stageRoot, outAbs);
  const outRelFwd = outRel.split(path.sep).join('/');
  const enumerated = files.filter((f) => f !== outRelFwd);

  const modelEntries = new Map(); // `${group}/${id}` -> entry
  const packEntries = new Map(); // pack dir rel -> entry
  const docsFiles = [];

  for (const rel of enumerated) {
    const parts = rel.split('/');
    if (parts[0] === 'models') {
      if (parts.length < 4) {
        fail(`staged model path must be models/<group>/<id>/<file…> (found ${rel})`);
        continue;
      }
      const group = parts[1];
      if (!MODEL_GROUPS.has(group)) {
        fail(`staged model group must be one of ${[...MODEL_GROUPS].join(', ')} (found ${rel})`);
        continue;
      }
      const id = parts[2];
      const key = `${group}/${id}`;
      if (!modelEntries.has(key)) {
        modelEntries.set(key, {
          id,
          label: id,
          kind: group,
          group,
          files: [],
        });
      }
      modelEntries.get(key).files.push({
        path: rel,
        required: true,
        sha256: await sha256File(path.join(stageRoot, rel)),
        sizeBytes: (await fs.stat(path.join(stageRoot, rel))).size,
      });
    } else if (parts[0] === 'packs') {
      if (parts.length < 4) {
        fail(`staged pack path must be packs/<classDir>/<packId>-<version>/<file…> (found ${rel})`);
        continue;
      }
      // Two coordinates for one pack dir: the on-disk path (stage-root
      // relative, for reading pack.json) and the manifest `dir` value
      // (PACKS-ROOT relative — the runtime's packEntryDir joins
      // <manifestDir>/packs/ + dir; see desktop/main/index.ts).
      const packDirFull = parts.slice(0, 3).join('/');
      const packDirRel = parts.slice(1, 3).join('/');
      if (!packEntries.has(packDirFull)) {
        const meta = await readPackMeta(path.join(stageRoot, packDirFull));
        const classDir = parts[1];
        packEntries.set(packDirFull, {
          id: meta?.id ?? parts[2],
          version: meta?.version ?? '1.0.0',
          name: meta?.name ?? parts[2],
          source_class: meta?.source_class ?? CLASS_SOURCE_CLASS.get(classDir) ?? classDir,
          dir: packDirRel,
          files: [],
        });
      }
      packEntries.get(packDirFull).files.push({
        path: rel,
        sha256: await sha256File(path.join(stageRoot, rel)),
        sizeBytes: (await fs.stat(path.join(stageRoot, rel))).size,
      });
    } else if (parts[0] === 'docs') {
      docsFiles.push({
        path: rel,
        required: true,
        sha256: await sha256File(path.join(stageRoot, rel)),
        sizeBytes: (await fs.stat(path.join(stageRoot, rel))).size,
      });
    } else {
      fail(`unrecognized staged path (expected models/ | packs/ | docs/): ${rel}`);
    }
  }

  const models = [...modelEntries.values()];
  // Sort files inside each entry for deterministic output (stable manifest bytes).
  for (const entry of models) entry.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (docsFiles.length > 0) {
    docsFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    models.push({ id: 'installer-docs', label: 'Packaged docs (licenses)', kind: 'docs', group: 'docs', files: docsFiles });
  }
  const packs = [...packEntries.values()];
  for (const entry of packs) entry.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const description =
    'TrainingApp installer resources manifest (issue #84/E1). Generated by ' +
    `desktop/scripts/${SCRIPT}.mjs; verified at startup by desktop/main/integrity-check.ts.` +
    (note !== undefined ? ` ${note}` : '');

  const manifest = { version: '1', description, models, packs };
  if (models.length === 0) fail('no models staged — the installer resources tree requires at least one models/ group');

  return manifest;
}

function componentSummary(manifest) {
  const groups = new Map();
  let packsBytes = 0;
  let docsBytes = 0;
  let total = 0;
  for (const model of manifest.models) {
    const bucket = model.group === 'docs' ? 'docs' : `models/${model.group}`;
    for (const file of model.files) {
      groups.set(bucket, (groups.get(bucket) ?? 0) + file.sizeBytes);
      total += file.sizeBytes;
    }
  }
  for (const pack of manifest.packs) {
    for (const file of pack.files) {
      packsBytes += file.sizeBytes;
      total += file.sizeBytes;
    }
  }
  const lines = [];
  for (const [bucket, bytes] of [...groups.entries()].sort()) lines.push(`${bucket}: ${bytes} bytes`);
  lines.push(`packs: ${packsBytes} bytes`);
  lines.push(`total: ${total} bytes`);
  lines.push(`TOTAL_BYTES: ${total}`);
  return lines;
}

async function verify(stageRoot, outPath) {
  const manifest = JSON.parse(await fs.readFile(outPath, 'utf8'));
  const outAbs = path.resolve(outPath);
  const outRel = path.relative(stageRoot, outAbs).split(path.sep).join('/');
  const treeFiles = (await walkFiles(stageRoot)).filter((f) => f !== outRel);
  const listed = new Map(); // path -> entry ref for messages
  for (const model of manifest.models ?? []) {
    for (const file of model.files ?? []) listed.set(file.path, file);
  }
  for (const pack of manifest.packs ?? []) {
    for (const file of pack.files ?? []) listed.set(file.path, file);
  }
  const treeSet = new Set(treeFiles);
  for (const rel of treeFiles) {
    if (!listed.has(rel)) fail(`unlisted staged file: ${rel}`);
  }
  for (const [rel, file] of listed) {
    if (!treeSet.has(rel)) {
      fail(`listed file missing from the staged tree: ${rel}`);
      continue;
    }
    const abs = path.join(stageRoot, rel);
    const actualSize = (await fs.stat(abs)).size;
    if (typeof file.sizeBytes === 'number' && actualSize !== file.sizeBytes) {
      fail(`size mismatch: ${rel} (manifest ${file.sizeBytes} vs staged ${actualSize} bytes)`);
    }
    if (typeof file.sha256 === 'string' && file.sha256.length > 0) {
      const actualHash = await sha256File(abs);
      if (actualHash !== file.sha256.toLowerCase()) {
        fail(`sha256 mismatch: ${rel} (manifest ${file.sha256} vs staged ${actualHash})`);
      }
    }
  }
  return treeFiles.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.stage === undefined) throw new Error('a stage dir is required (--stage-dir <dir>)');
  stage = path.resolve(args.stage);
  const stageStat = await fs.stat(stage).catch(() => null);
  if (stageStat === null || !stageStat.isDirectory()) throw new Error(`stage dir is not a directory: ${stage}`);
  const outPath = path.resolve(args.out ?? path.join(stage, 'manifest.json'));

  if (args.verify) {
    try {
      await fs.access(outPath);
    } catch {
      throw new Error(`--verify requires an existing manifest at ${outPath} (generate first; verify never regenerates)`);
    }
    const fileCount = await verify(stage, outPath);
    if (errors.length > 0) {
      for (const message of errors) console.error(`${SCRIPT}: FAIL ${message}`);
      console.error(`${SCRIPT}: verify FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
      process.exit(1);
    }
    console.log(`${SCRIPT}: verify clean (${fileCount} staged files match the manifest at ${path.relative(process.cwd(), outPath) || outPath})`);
    return;
  }

  const manifest = await buildManifest(stage, outPath, args.note);
  if (errors.length > 0) {
    for (const message of errors) console.error(`${SCRIPT}: FAIL ${message}`);
    console.error(`${SCRIPT}: generation FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}); no manifest written`);
    process.exit(1);
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const line of componentSummary(manifest)) console.log(`${SCRIPT}: ${line}`);
  console.log(`${SCRIPT}: wrote ${outPath} (${manifest.models.length} model entries, ${manifest.packs.length} pack entries)`);
}

main().catch((err) => {
  console.error(`${SCRIPT}: ${err instanceof Error ? err.message : err}`);
  console.error(usage());
  process.exit(1);
});
