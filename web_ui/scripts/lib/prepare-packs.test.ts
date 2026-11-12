// @vitest-environment node
/**
 * #266 (AC15, frozen check C12): prepare-packs staging — the desktop-parity
 * selector (fail-loud operator trees, silent bundled-min fixture fallback,
 * empty manifest when neither source exists), the deterministic zip writer
 * (packtool writeDeterministicZip conventions), the manifest
 * (id/version/file/sha256/size) with its source LOGGED — plus the
 * installability smoke: EVERY generated archive (operator + fixture mode)
 * opens through the production openPackArchive and its root pack.json parses.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import JSZip from 'jszip';

import {
  DOCS_PACK_DIR,
  TRAINING_PACK_DIR,
  TRAINING_PACK_VERSION,
  resolveBundledPackSources,
} from './pack-selector.mjs';
import { listPackFilesRelative, stageBundledPacks, writeDeterministicPackZip } from '../prepare-packs.mjs';
import { openPackArchive, sourceFromBytes } from '../../src/lib/packs/pack-extract-browser';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-packs-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const enc = new TextEncoder();
const sha = (b: Uint8Array | Buffer): string => createHash('sha256').update(b).digest('hex');

function writePack(dir: string, id: string, version: string, extra = false): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      id,
      name: `Pack ${id}`,
      version,
      published_at: '2026-10-01T00:00:00Z',
      source_class: 'bundled',
      embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
      docs: [{ path: 'docs/doc.json', sha256: sha(enc.encode('{"a":1}')), title: 'Doc', mime: 'application/json' }],
    }),
  );
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'doc.json'), '{"a":1}');
  if (extra) {
    fs.mkdirSync(path.join(dir, 'assets', 'player'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'player', 'story.html'), '<html></html>');
  }
}

function operatorRoot(root: string): string {
  const dir = path.join(root, 'desktop', 'knowledge-pack-src');
  return dir;
}

/** A complete small operator tree: the SAME pinned dir names as desktop. */
function makeOperatorTree(root: string): void {
  writePack(path.join(operatorRoot(root), DOCS_PACK_DIR), 'opmed-initial', '1.0.0');
  writePack(path.join(operatorRoot(root), TRAINING_PACK_DIR), 'opmed-cdp-mlc', TRAINING_PACK_VERSION, true);
}

function makeFixtureTree(root: string): void {
  writePack(path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'), 'bundled-min', '1.0.0');
}

describe('pack-selector (desktop parity)', () => {
  it('pins the SAME directories desktop pins (source-scan lockstep guard)', () => {
    const desktopStager = fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'scripts', 'stage-installer-resources.mjs'), 'utf8');
    expect(desktopStager).toContain(`docsPackDir: '${DOCS_PACK_DIR}'`);
    expect(desktopStager).toContain(`const TRAINING_PACK_VERSION = '${TRAINING_PACK_VERSION}'`);
    expect(TRAINING_PACK_DIR).toBe(`opmed-cdp-mlc-${TRAINING_PACK_VERSION}`);
  });

  it('operator root present: BOTH packs required, fixture ignored', () => {
    const root = tmp();
    makeOperatorTree(root);
    makeFixtureTree(root);
    const out = resolveBundledPackSources({
      knowledgePackSrcRoot: operatorRoot(root),
      fixturePackSource: path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'),
    });
    expect(out.source).toBe('operator');
    expect(out.packs.map((p) => p.classDir)).toEqual(['bundled-docs', 'training']);
  });

  it('half-built operator tree fails loud by name (never a silent fixture fallback)', () => {
    const root = tmp();
    writePack(path.join(operatorRoot(root), DOCS_PACK_DIR), 'opmed-initial', '1.0.0');
    const problems: string[] = [];
    const out = resolveBundledPackSources({
      knowledgePackSrcRoot: operatorRoot(root),
      fixturePackSource: path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'),
      onProblem: (m) => problems.push(m),
    });
    expect(out.packs).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/training pack missing.*opmed-cdp-mlc-1\.0\.1\/pack\.json not found/);
  });

  it('an unexpected training-pack version dir is rejected loud', () => {
    const root = tmp();
    makeOperatorTree(root);
    // A stale second version of the course pack alongside the pinned one.
    writePack(path.join(operatorRoot(root), 'opmed-cdp-mlc-1.0.0'), 'opmed-cdp-mlc', '1.0.0');
    const problems: string[] = [];
    resolveBundledPackSources({
      knowledgePackSrcRoot: operatorRoot(root),
      fixturePackSource: path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'),
      onProblem: (m) => problems.push(m),
    });
    expect(problems.join(' ')).toMatch(/unexpected training pack dir.*opmed-cdp-mlc-1\.0\.0/);
  });

  it('wholly absent operator root: the SILENT fixture fallback', () => {
    const root = tmp();
    makeFixtureTree(root);
    const out = resolveBundledPackSources({
      knowledgePackSrcRoot: path.join(root, 'desktop', 'knowledge-pack-src'),
      fixturePackSource: path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'),
    });
    expect(out.source).toBe('fixture');
    expect(out.packs).toEqual([{ source: path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'), classDir: 'bundled-docs' }]);
  });
});

describe('writeDeterministicPackZip (packtool conventions)', () => {
  it('is deterministic: two stagings of the same tree are byte-identical', async () => {
    const root = tmp();
    const packDir = path.join(root, 'pack');
    writePack(packDir, 'x', '1.0.0', true);
    const a = path.join(root, 'a.zip');
    const b = path.join(root, 'b.zip');
    await writeDeterministicPackZip(packDir, a, new Date('2026-10-01T00:00:00Z'));
    await writeDeterministicPackZip(packDir, b, new Date('2026-10-01T00:00:00Z'));
    expect(sha(fs.readFileSync(a))).toBe(sha(fs.readFileSync(b)));
  });

  it('pack.json appears exactly once, at the archive root; entries are forward-slash relative', async () => {
    const root = tmp();
    const packDir = path.join(root, 'pack');
    writePack(packDir, 'x', '1.0.0', true);
    const out = path.join(root, 'x.zip');
    await writeDeterministicPackZip(packDir, out, new Date('2026-10-01T00:00:00Z'));
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const names = Object.keys(zip.files);
    expect(names.filter((n) => n === 'pack.json')).toHaveLength(1);
    expect(names).toContain('assets/player/story.html');
    expect(names.every((n) => !n.includes('\\'))).toBe(true);
  });

  it('refuses non-regular entries (symlinks/FIFOs) via lstat', () => {
    const root = tmp();
    const packDir = path.join(root, 'pack');
    writePack(packDir, 'x', '1.0.0');
    const fakeStat = { isFile: () => false, isDirectory: () => false };
    expect(() => listPackFilesRelative(packDir, () => fakeStat as unknown as fs.Stats)).toThrow(/non-regular entry/);
  });
});

describe('stageBundledPacks (AC15: manifest + source log + installability smoke)', () => {
  it('operator mode: both zips + manifest, source LOGGED, every archive installable', async () => {
    const root = tmp();
    makeOperatorTree(root);
    const outDir = path.join(root, 'public', 'packs');
    const logs: string[] = [];
    const { problems, manifest, source } = await stageBundledPacks({
      repoRoot: root,
      outDir,
      manifestPath: path.join(outDir, 'packs.manifest.json'),
      log: (m) => logs.push(m),
    });
    expect(problems).toEqual([]);
    expect(source).toBe('operator');
    // The source is logged: operator.
    expect(logs.join('\n')).toMatch(/source: operator desktop.*knowledge-pack-src \(docs \+ training packs\)/);
    // Manifest entries: id/version/file/sha256/size, hashes matching the files.
    expect(manifest.packs.map((p) => p.id)).toEqual(['opmed-initial', 'opmed-cdp-mlc']);
    for (const entry of manifest.packs) {
      const bytes = fs.readFileSync(path.join(outDir, entry.file));
      expect(bytes.byteLength).toBe(entry.size);
      expect(sha(bytes)).toBe(entry.sha256);
      // C12 installability smoke: open through the PRODUCTION archive
      // guards and parse the root pack.json.
      const archive = await openPackArchive(sourceFromBytes(new Uint8Array(bytes)), entry.file);
      const raw = await archive.readEntry(archive.manifestEntry);
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { id: string; version: string };
      expect(parsed.id).toBe(entry.id);
      expect(parsed.version).toBe(entry.version);
    }
    // The manifest file itself was written.
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'packs.manifest.json'), 'utf8'));
    expect(written).toEqual(manifest);
  });

  it('fixture mode (silent fallback): the bundled-min fixture ships and is installable', async () => {
    const root = tmp();
    makeFixtureTree(root); // NO operator tree at all
    const outDir = path.join(root, 'public', 'packs');
    const logs: string[] = [];
    const { problems, manifest, source } = await stageBundledPacks({
      repoRoot: root,
      outDir,
      manifestPath: path.join(outDir, 'packs.manifest.json'),
      log: (m) => logs.push(m),
    });
    expect(problems).toEqual([]);
    expect(source).toBe('fixture');
    expect(logs.join('\n')).toMatch(/source: fixture contracts.*bundled-min.*silent bundled-min fallback/);
    expect(manifest.packs.map((p) => p.id)).toEqual(['bundled-min']);
    for (const entry of manifest.packs) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(outDir, entry.file)));
      const archive = await openPackArchive(sourceFromBytes(bytes), entry.file);
      const raw = await archive.readEntry(archive.manifestEntry);
      expect(JSON.parse(new TextDecoder().decode(raw)).id).toBe(entry.id);
    }
  });

  it('neither source: an EMPTY manifest plus a loud log', async () => {
    const root = tmp();
    const outDir = path.join(root, 'public', 'packs');
    const logs: string[] = [];
    const { problems, manifest, source } = await stageBundledPacks({
      repoRoot: root,
      outDir,
      manifestPath: path.join(outDir, 'packs.manifest.json'),
      log: (m) => logs.push(m),
    });
    expect(problems).toEqual([]);
    expect(source).toBe('empty');
    expect(manifest).toEqual({ packs: [] });
    expect(logs.join('\n')).toMatch(/NO bundled pack source.*EMPTY packs manifest/);
  });

  it('an incomplete operator tree fails the staging loud by name and writes no manifest', async () => {
    const root = tmp();
    writePack(path.join(operatorRoot(root), DOCS_PACK_DIR), 'opmed-initial', '1.0.0');
    // Training pack missing: NO silent fallback.
    const outDir = path.join(root, 'public', 'packs');
    const manifestPath = path.join(outDir, 'packs.manifest.json');
    const { problems } = await stageBundledPacks({ repoRoot: root, outDir, manifestPath, log: () => {} });
    expect(problems.join(' ')).toMatch(/training pack missing/);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('REL-6: a mid-loop failure rolls back the zips THIS run wrote — no half-staged set beside the old manifest', async () => {
    const root = tmp();
    makeOperatorTree(root);
    // The SECOND pack's pack.json is corrupt: the selector is satisfied (the
    // file exists), the FIRST pack archives fine, then the staging fails.
    fs.writeFileSync(
      path.join(operatorRoot(root), TRAINING_PACK_DIR, 'pack.json'),
      '{ not json',
      'utf8',
    );
    const outDir = path.join(root, 'public', 'packs');
    const manifestPath = path.join(outDir, 'packs.manifest.json');
    const { problems } = await stageBundledPacks({ repoRoot: root, outDir, manifestPath, log: () => {} });
    expect(problems.join(' ')).toMatch(/pack manifest unreadable/);
    // No manifest was published...
    expect(fs.existsSync(manifestPath)).toBe(false);
    // ...and the docs zip this run DID write was unlinked (the on-disk set
    // stays whatever the previous consistent run left, never a half-staged
    // mixture).
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});
