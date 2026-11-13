// @vitest-environment node
/**
 * #266 (AC16, frozen check C13): the dist/packs/ gate — verifyDistPacks (the
 * seam validate-build.mjs runs on BOTH validation paths) fails NAMING THE
 * PACK on a missing/mismatched file, refuses Git-LFS pointer stubs, and
 * passes a clean staging.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { verifyDistPacks } from './validate-packs.mjs';
import { LFS_POINTER_PREFIX } from './lfs-detect.mjs';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-packs-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Case {
  file: string;
  bytes: Buffer;
  sha256: string;
  size: number;
}

function stage(entries: Case[]): { distPacksDir: string; manifestPath: string } {
  const dir = tmp();
  const distPacksDir = path.join(dir, 'dist', 'packs');
  fs.mkdirSync(distPacksDir, { recursive: true });
  const packs = [];
  for (const entry of entries) {
    fs.writeFileSync(path.join(distPacksDir, entry.file), entry.bytes);
    packs.push({ id: entry.file.replace(/-\d+\.\d+\.\d+\.zip$/, ''), version: '1.0.0', file: entry.file, sha256: entry.sha256, size: entry.size });
  }
  const manifestPath = path.join(distPacksDir, 'packs.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ packs }));
  return { distPacksDir, manifestPath };
}

function probe(distPacksDir: string, manifestPath: string): Promise<string[]> {
  const problems: string[] = [];
  return verifyDistPacks({ distPacksDir, manifestPath, onProblem: (m) => problems.push(m) }).then(() => problems);
}

describe('verifyDistPacks (#266 AC16)', () => {
  it('passes a clean staging', async () => {
    const bytes = Buffer.from('zip-bytes-v1');
    const { distPacksDir, manifestPath } = stage([
      {
        file: 'course-a-1.0.0.zip',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
      },
    ]);
    expect(await probe(distPacksDir, manifestPath)).toEqual([]);
  });

  it('fails NAMING THE PACK when the archive is missing from dist', async () => {
    const dir = tmp();
    const distPacksDir = path.join(dir, 'dist', 'packs');
    fs.mkdirSync(distPacksDir, { recursive: true });
    fs.writeFileSync(
      path.join(distPacksDir, 'packs.manifest.json'),
      JSON.stringify({ packs: [{ id: 'course-a', version: '1.0.0', file: 'course-a-1.0.0.zip', sha256: '0'.repeat(64), size: 10 }] }),
    );
    const problems = await probe(distPacksDir, path.join(distPacksDir, 'packs.manifest.json'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/pack "course-a"/);
    expect(problems[0]).toMatch(/course-a-1\.0\.0\.zip/);
  });

  it('fails naming the pack on a size mismatch', async () => {
    const bytes = Buffer.from('zip-bytes');
    const { distPacksDir, manifestPath } = stage([
      { file: 'course-a-1.0.0.zip', bytes, sha256: 'f'.repeat(64), size: bytes.byteLength + 5 },
    ]);
    const problems = await probe(distPacksDir, manifestPath);
    expect(problems[0]).toMatch(/pack "course-a": size mismatch/);
  });

  it('fails naming the pack on a sha256 mismatch', async () => {
    const bytes = Buffer.from('zip-bytes');
    const { distPacksDir, manifestPath } = stage([
      { file: 'course-a-1.0.0.zip', bytes, sha256: 'a'.repeat(64), size: bytes.byteLength },
    ]);
    const problems = await probe(distPacksDir, manifestPath);
    expect(problems[0]).toMatch(/pack "course-a": sha256 mismatch/);
  });

  it('refuses a Git-LFS pointer stub naming the pack', async () => {
    const bytes = Buffer.from(`${LFS_POINTER_PREFIX}\noid sha256:${'0'.repeat(64)}\nsize 12345\n`);
    const { distPacksDir, manifestPath } = stage([
      {
        file: 'course-a-1.0.0.zip',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
      },
    ]);
    const problems = await probe(distPacksDir, manifestPath);
    expect(problems[0]).toMatch(/Git-LFS pointer stub.*course-a-1\.0\.0\.zip.*pack "course-a"/);
  });

  it('a missing manifest is a named failure', async () => {
    const dir = tmp();
    const problems = await probe(path.join(dir, 'dist', 'packs'), path.join(dir, 'dist', 'packs', 'packs.manifest.json'));
    expect(problems[0]).toMatch(/packs manifest is missing/);
  });

  it('an EMPTY manifest with no dist/packs directory is not a failure', async () => {
    const dir = tmp();
    const distPacksDir = path.join(dir, 'dist', 'packs');
    fs.mkdirSync(distPacksDir, { recursive: true });
    const manifestPath = path.join(distPacksDir, 'packs.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ packs: [] }));
    expect(await probe(distPacksDir, manifestPath)).toEqual([]);
  });

  it('refuses a manifest file name that escapes the packs directory', async () => {
    const dir = tmp();
    const distPacksDir = path.join(dir, 'dist', 'packs');
    fs.mkdirSync(distPacksDir, { recursive: true });
    const manifestPath = path.join(distPacksDir, 'packs.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ packs: [{ id: 'evil', version: '1.0.0', file: '../../outside.zip', sha256: '0'.repeat(64), size: 1 }] }));
    const problems = await probe(distPacksDir, manifestPath);
    expect(problems[0]).toMatch(/escapes the packs directory/);
  });
});
