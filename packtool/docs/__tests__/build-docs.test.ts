// docs/__tests__/build-docs.test.ts — in-repo regression family for issue #73
// (build-docs / diff / verify widenings). The FROZEN acceptance checks for
// the issue-tracer trace live in .agents/issue-traces/ (arm's-length specs);
// these vitest cases are the permanent suite that keeps the behavior honest
// after the trace closes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync as fs_renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { buildDocsPack } from '../build-docs';
import { diffPacks, formatPackDiff } from '../diff';
import { verifyPack } from '../../build/verify';
import { resolveBuildEmbedder } from '../../build/embedder';
import { validatePackManifest } from '../../build/pack-json';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKTOOL_ROOT = path.resolve(THIS_DIR, '..', '..');
const REPO_ROOT = path.resolve(PACKTOOL_ROOT, '..');
const DIST_CLI = path.join(PACKTOOL_ROOT, 'dist', 'cli.js');

const scratchRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

function writeSource(dir: string, rel: string, content: string): void {
  const target = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

async function unzip(zipPath: string, dest: string): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  for (const entry of Object.values(zip.files)) {
    const target = path.join(dest, ...entry.name.split('/'));
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await entry.async('nodebuffer'));
  }
}

const FIXED_TIME = '2026-09-19T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-docs (issue #73)', () => {
  it('builds a bundled pack that verifies OK without player assets', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-src-');
    writeSource(src, 'alpha.md', '# Alpha\n\nSome alpha content for the pack.\n');
    writeSource(src, 'beta.json', JSON.stringify({ title: 'Beta', text: 'Beta text body.' }));
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    const result = await buildDocsPack({
      sourceDir: src,
      out,
      embedder: 'hash',
      publishedAt: FIXED_TIME,
      id: 'bd-basic',
      version: '1.0.0',
    });
    expect(result.docs).toBe(2);
    expect(result.chunks).toBeGreaterThan(0);
    const verify = await verifyPack(out);
    expect(verify.ok).toBe(true);
    expect(verify.problems).toEqual([]);
    expect(verify.warnings).toEqual([]);
  });

  it('two builds with fixed --published-at are byte-identical (pack.json AND zip)', { timeout: 30_000 }, async () => {
    const makeSource = (): string => {
      const src = makeTempDir('bd-det-');
      writeSource(src, 'guide.txt', 'Packing guide content that is stable across builds.\n');
      writeSource(src, 'faq.json', JSON.stringify({ title: 'FAQ', text: 'Stable frequently asked questions.' }));
      return src;
    };
    const outA = path.join(makeTempDir('bd-out-'), 'a.zip');
    const outB = path.join(makeTempDir('bd-out-'), 'b.zip');
    await buildDocsPack({ sourceDir: makeSource(), out: outA, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-det', version: '1.0.0' });
    await buildDocsPack({ sourceDir: makeSource(), out: outB, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-det', version: '1.0.0' });
    const zipA = readFileSync(outA);
    const zipB = readFileSync(outB);
    expect(zipA.equals(zipB)).toBe(true);
    const unpackA = makeTempDir('bd-unz-');
    const unpackB = makeTempDir('bd-unz-');
    await unzip(outA, unpackA);
    await unzip(outB, unpackB);
    expect(readFileSync(path.join(unpackA, 'pack.json')).equals(readFileSync(path.join(unpackB, 'pack.json')))).toBe(true);
  });

  it('stamps the embedder identity (hash -> hash/384) and strategy fixed-words', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-stamp-');
    writeSource(src, 'doc.txt', 'Identity stamp body text.\n');
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await buildDocsPack({ sourceDir: src, out, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-stamp', version: '1.0.0' });
    const manifest = JSON.parse(
      (await (await JSZip.loadAsync(readFileSync(out))).file('pack.json')!.async('string')),
    ) as { embedding: { model_id: string; dims: number }; chunking: { strategy: string } };
    expect(manifest.embedding.model_id).toBe('hash');
    expect(manifest.embedding.dims).toBe(384);
    expect(manifest.chunking.strategy).toBe('fixed-words');
  });

  it('diff reports added/changed docs and the pinned chunks line', { timeout: 30_000 }, async () => {
    const srcA = makeTempDir('bd-diffa-');
    writeSource(srcA, 'keep-alpha.md', '# Alpha\n\nOriginal alpha body.\n');
    writeSource(srcA, 'keep-beta.txt', 'Beta body one.\n');
    const srcB = makeTempDir('bd-diffb-');
    writeSource(srcB, 'keep-alpha.md', '# Alpha\n\nRewritten alpha body.\n');
    writeSource(srcB, 'keep-beta.txt', 'Beta body one.\n');
    writeSource(srcB, 'added-gamma.md', '# Gamma\n\nGamma is new.\n');
    const outA = path.join(makeTempDir('bd-out-'), 'a.zip');
    const outB = path.join(makeTempDir('bd-out-'), 'b.zip');
    await buildDocsPack({ sourceDir: srcA, out: outA, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-diff', version: '1.0.0' });
    await buildDocsPack({ sourceDir: srcB, out: outB, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-diff', version: '1.0.1' });
    const diff = await diffPacks(outA, outB);
    const lines = formatPackDiff(diff);
    expect(lines.some((l) => /^added: docs\/added-gamma\.md \(sha256 [0-9a-f]{64}\)$/.test(l))).toBe(true);
    expect(lines.some((l) => /^changed: docs\/keep-alpha\.md \(sha256 [0-9a-f]{64} -> [0-9a-f]{64}\)$/.test(l))).toBe(true);
    // The pinned contract line — asserted byte-exactly.
    expect(lines).toContain('chunks: 2 -> 3 (delta +1)');
    expect(lines).toContain('summary: 1 added, 0 removed, 1 changed');
  });

  it('diff of identical packs reports the zero summary', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-same-');
    writeSource(src, 'only.md', '# Only\n\nOne doc.\n');
    const outA = path.join(makeTempDir('bd-out-'), 'a.zip');
    const outB = path.join(makeTempDir('bd-out-'), 'b.zip');
    await buildDocsPack({ sourceDir: src, out: outA, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-same', version: '1.0.0' });
    await buildDocsPack({ sourceDir: src, out: outB, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-same', version: '1.0.0' });
    const lines = formatPackDiff(await diffPacks(outA, outB));
    expect(lines).toContain('summary: 0 added, 0 removed, 0 changed');
  });

  it('diff reports chunks: n/a when a pack has no prebuilt index', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-noidx-');
    writeSource(src, 'doc.md', '# Doc\n\nBody.\n');
    const outZip = path.join(makeTempDir('bd-out-'), 'built.zip');
    await buildDocsPack({ sourceDir: src, out: outZip, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-noidx', version: '1.0.0' });
    // A C1-valid manifest WITHOUT an index block (like the bundled-min fixture).
    const docBytes = Buffer.from('# Doc\n\nBody.\n', 'utf8');
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(docBytes).digest('hex');
    const dirPack = makeTempDir('bd-dirpack-');
    mkdirSync(path.join(dirPack, 'docs'), { recursive: true });
    writeFileSync(path.join(dirPack, 'docs', 'doc.md'), docBytes);
    writeFileSync(
      path.join(dirPack, 'pack.json'),
      JSON.stringify({
        id: 'bd-noidx-dir',
        name: 'No index dir pack',
        version: '1.0.0',
        published_at: FIXED_TIME,
        source_class: 'bundled',
        embedding: { model_id: 'hash', dims: 384, normalize: true },
        chunking: { strategy: 'fixed-words', size: 256, overlap: 100 },
        docs: [{ path: 'docs/doc.md', sha256: sha, title: 'Doc', mime: 'text/markdown' }],
      }, null, 2),
    );
    const lines = formatPackDiff(await diffPacks(dirPack, outZip));
    expect(lines).toContain('chunks: n/a');
  });

  it('verify refuses a tampered sqlite_vec_version pin', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-pin-');
    writeSource(src, 'doc.md', '# Pin\n\nBody.\n');
    const outZip = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await buildDocsPack({ sourceDir: src, out: outZip, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-pin', version: '1.0.0' });
    const unpacked = makeTempDir('bd-tamper-');
    await unzip(outZip, unpacked);
    const manifestPath = path.join(unpacked, 'pack.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { index: { sqlite_vec_version: string } };
    manifest.index.sqlite_vec_version = '9.9.9';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const verify = await verifyPack(unpacked);
    expect(verify.ok).toBe(false);
    expect(verify.problems.some((p => p.includes('sqlite_vec')))).toBe(true);
  });

  it('verify warns on a wrong expected model and stays ok', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-warn-');
    writeSource(src, 'doc.md', '# Warn\n\nBody.\n');
    const outZip = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await buildDocsPack({ sourceDir: src, out: outZip, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-warn', version: '1.0.0' });
    const verify = await verifyPack(outZip, { expectedModelId: 'bge-small-en-v1.5' });
    expect(verify.ok).toBe(true);
    expect(verify.warnings).toHaveLength(1);
    expect(verify.warnings[0]).toContain('embedding model mismatch');
  });

  it('refuses an empty source directory', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-empty-');
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await expect(
      buildDocsPack({ sourceDir: src, out, embedder: 'hash', id: 'bd-empty', version: '1.0.0' }),
    ).rejects.toThrow(/no supported documents/);
  });

  it('skips unsupported files with a stderr note', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-skip-');
    writeSource(src, 'real.md', '# Real\n\nBody.\n');
    writeSource(src, 'image.png', 'not really a png');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    const result = await buildDocsPack({ sourceDir: src, out, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-skip', version: '1.0.0' });
    expect(result.docs).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('build-docs: skipping unsupported file: image.png');
    errSpy.mockRestore();
  });

  it('refuses a .json document without a string text field', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-badjson-');
    writeSource(src, 'broken.json', JSON.stringify({ title: 'no text here' }));
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await expect(
      buildDocsPack({ sourceDir: src, out, embedder: 'hash', id: 'bd-badjson', version: '1.0.0' }),
    ).rejects.toThrow(/string "text"/);
  });

  // Junctions are a Windows concept; on POSIX the same refusal is exercised
  // by extract.ts's lstat check with a real symlink (no POSIX CI leg runs
  // this suite today, but keep the suite portable).
  const itJunction = process.platform === 'win32' ? it : it.skip;
  itJunction('refuses a symlink/junction inside the source tree', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-link-');
    writeSource(src, 'real.md', '# Real\n\nBody.\n');
    const outside = makeTempDir('bd-outside-');
    symlinkSync(outside, path.join(src, 'linked'), 'junction');
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    await expect(
      buildDocsPack({ sourceDir: src, out, embedder: 'hash', id: 'bd-link', version: '1.0.0' }),
    ).rejects.toThrow(/symlink\/junction/);
  });

  it('builds zero chunks for an all-empty-text corpus without failing', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-zerotext-');
    writeSource(src, 'empty.txt', '');
    const out = path.join(makeTempDir('bd-out-'), 'pack.zip');
    const result = await buildDocsPack({ sourceDir: src, out, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-zerotext', version: '1.0.0' });
    expect(result.docs).toBe(1);
    expect(result.chunks).toBe(0);
    const verify = await verifyPack(out);
    expect(verify.ok).toBe(true);
  });
});

describe('build-docs CLI parse-time refusals (issue #73)', () => {
  const itCli = existsSync(DIST_CLI) ? it : it.skip;

  itCli('malformed --published-at is a usage error (exit 2)', () => {
    const run = spawnSync(process.execPath, [DIST_CLI, 'build-docs', '.', '-o', 'x.zip', '--published-at', 'not-a-date'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: packtool build-docs');
  });

  itCli('--source-class outside the C1 enum is a usage error (exit 2)', () => {
    const run = spawnSync(process.execPath, [DIST_CLI, 'build-docs', '.', '-o', 'x.zip', '--source-class', 'internal'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: packtool build-docs');
  });
});

describe('CI fixture-pack command parity (issue #73 final-critic Round 1)', () => {
  const itCli = existsSync(DIST_CLI) ? it : it.skip;

  /** A 134-byte fake model dir: the size class of a Git LFS pointer file that
   * a default CI checkout carries when lfs is not enabled. */
  function makeLfsPointerModelDir(): string {
    const dir = makeTempDir('bd-lfsptr-');
    mkdirSync(path.join(dir, 'fake-model', 'onnx'), { recursive: true });
    writeFileSync(
      path.join(dir, 'fake-model', 'onnx', 'model.onnx'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 402505222\n',
      'utf8',
    );
    return path.join(dir, 'fake-model');
  }

  const poisonedModelDir = (): string => makeLfsPointerModelDir();
  const poisonedEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    TRAININGAPP_EMBEDDING_MODEL_DIR: poisonedModelDir(),
  });

  itCli('the CI fixture command (hash embedder) builds under an LFS-pointer model dir', { timeout: 60_000 }, () => {
    const out = path.join(makeTempDir('bd-out-'), 'out.zip');
    const run = spawnSync(
      process.execPath,
      [DIST_CLI, 'build-docs', 'contracts/fixtures/source-docs/', '--id', 'test-pack', '--version', '1.0.0', '--embedder', 'hash', '-o', out],
      { encoding: 'utf8', env: poisonedEnv(), cwd: REPO_ROOT },
    );
    expect(run.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const verify = spawnSync(process.execPath, [DIST_CLI, 'verify', out], {
      encoding: 'utf8',
      env: poisonedEnv(),
      cwd: REPO_ROOT,
    });
    expect(verify.status).toBe(0);
    expect(verify.stderr).toContain('verify: OK');
  });

  it('onnx resolution refuses to stage when no valid model exists anywhere (the CI LFS-pointer condition)', () => {
    // Deterministic stand-in for the CLI-level behavior: a repo root with no
    // models/ plus an invalid env dir must make onnx resolution throw the
    // loud staging error (dev boxes with pulled LFS weights cannot exercise
    // this through the CLI, but CI always looks like this).
    const emptyRepo = makeTempDir('bd-emptyrepo-');
    expect(() =>
      resolveBuildEmbedder({ embedder: 'onnx', modelDir: poisonedModelDir(), repoRoot: emptyRepo }),
    ).toThrow(/No embedding model staged/);
  });
});

describe('manifest control-character rejection (PRR-120-F1)', () => {
  function validManifest(pathValue: string, modelId: string): Record<string, unknown> {
    return {
      id: 'bd-cc',
      name: 'Control-char probe',
      version: '1.0.0',
      published_at: FIXED_TIME,
      source_class: 'bundled',
      embedding: { model_id: modelId, dims: 384, normalize: true },
      chunking: { strategy: 'fixed-words', size: 256, overlap: 100 },
      docs: [{ path: pathValue, sha256: 'a'.repeat(64), title: 'T', mime: 'text/plain' }],
    };
  }

  it('rejects a control character in a doc path (C1 validator parity, diff-report injection)', () => {
    const problems = validatePackManifest(validManifest('docs/x\ny.md', 'hash'));
    expect(problems.ok).toBe(false);
    expect(problems.problems.some((p) => p.includes('control character'))).toBe(true);
  });

  it('rejects an escape character in a doc path (terminal injection)', () => {
    const problems = validatePackManifest(validManifest('docs/x\u001b[31m.md', 'hash'));
    expect(problems.ok).toBe(false);
    expect(problems.problems.some((p) => p.includes('control character'))).toBe(true);
  });

  it('rejects control characters in embedding.model_id (verify warning-line injection)', () => {
    const problems = validatePackManifest(validManifest('docs/ok.md', 'm\u001b[31mHACK'));
    expect(problems.ok).toBe(false);
    expect(problems.problems.some((p) => p.includes('control character'))).toBe(true);
  });

  it('accepts printable non-ASCII model ids (only control characters are refused)', () => {
    const problems = validatePackManifest(validManifest('docs/ok.md', 'modele-étiquette-v1'));
    expect(problems.ok).toBe(true);
  });
});

describe('diff honors a manifest-declared index path (PRR-120-F4)', () => {
  it('reads chunk counts from a non-default index location', { timeout: 30_000 }, async () => {
    const src = makeTempDir('bd-idxfp-');
    writeSource(src, 'solo.md', '# Solo\n\nOne chunk body.\n');
    const outZip = path.join(makeTempDir('bd-out-'), 'built.zip');
    await buildDocsPack({ sourceDir: src, out: outZip, embedder: 'hash', publishedAt: FIXED_TIME, id: 'bd-idxfp', version: '1.0.0' });
    const unpacked = makeTempDir('bd-idxfp-dir-');
    await unzip(outZip, unpacked);
    // Relocate the index and point the manifest at the new location.
    mkdirSync(path.join(unpacked, 'data'), { recursive: true });
    fs_renameSync(path.join(unpacked, 'index.sqlite'), path.join(unpacked, 'data', 'custom.sqlite'));
    const manifestPath = path.join(unpacked, 'pack.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { index: { path: string } };
    manifest.index.path = 'data/custom.sqlite';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const lines = formatPackDiff(await diffPacks(unpacked, unpacked));
    expect(lines).toContain('chunks: 1 -> 1 (delta +0)');
  });
});
