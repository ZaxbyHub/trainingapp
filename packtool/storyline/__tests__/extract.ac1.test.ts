// AC1 — Golden fixture extraction (CI), issue #77.
//
// Frozen contract under test (no implementation exists yet; these imports MUST
// stay the spec for packtool/storyline):
//   - `packtool/dist/cli.js` is the built CLI bin. Invoked as
//       node packtool/dist/cli.js storyline extract tests/fixtures/storyline-mini --out <tmp>
//     with cwd = repo root, it writes
//       <out>/slides/slide-<NNN>-<slideId>.json  and  <out>/outline.json
//     (JSON.stringify(doc, null, 2) + "\n", per G5).
//
// The produced output must match the committed hand-derived golden files at
// tests/fixtures/storyline-mini/expected/ byte-for-byte, and the produced file
// set must be exactly the golden set (no extra, no missing files).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
// Import of the not-yet-existing implementation keeps this suite red until the
// extractor exists (extractPublishDir is the frozen API for the CLI step).
import { extractPublishDir } from '../extract';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PACKTOOL_DIR = join(REPO_ROOT, 'packtool');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'storyline-mini');
const GOLDEN_DIR = join(FIXTURE_DIR, 'expected');

// The complete golden output set, frozen from the committed fixture.
const EXPECTED_FILES = [
  'outline.json',
  'slides/slide-001-5rN4PvXJM5d.json',
  'slides/slide-002-5b8obQzpBWu.json',
  'slides/slide-003-6fxKq2mV8bR.json',
  'slides/slide-004-7bLnWpQxT4s.json',
  'slides/slide-005-8cMoXyRz5Jq.json',
  'slides/slide-006-9dNpYzSa6Kr.json',
];

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

// dist/ is stale when cli.js is missing or any packtool/storyline/*.ts is newer.
function distIsStale(): boolean {
  const cli = join(PACKTOOL_DIR, 'dist', 'cli.js');
  if (!existsSync(cli)) return true;
  const cliMtime = statSync(cli).mtimeMs;
  const tsFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) tsFiles.push(p);
    }
  };
  walk(join(PACKTOOL_DIR, 'storyline'));
  return tsFiles.some((p) => statSync(p).mtimeMs > cliMtime);
}

describe('AC1: golden fixture extraction via built CLI', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'packtool-ac1-'));

  beforeAll(() => {
    if (distIsStale()) {
      // Best-effort build; if it fails, the CLI spawn below reports the failure.
      spawnSync('npm', ['run', 'build', '--prefix', 'packtool'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
    }
  });

  it('CLI extracts the fixture publish dir', () => {
    const res = spawnSync(
      process.execPath,
      ['packtool/dist/cli.js', 'storyline', 'extract', 'tests/fixtures/storyline-mini', '--out', outDir],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(res.error).toBeUndefined();
    expect(
      res.status,
      `cli should exit 0\nstdout:\n${res.stdout ?? ''}\nstderr:\n${res.stderr ?? ''}`,
    ).toBe(0);
  });

  it('produced file set equals the golden file set exactly', () => {
    // The golden tree on disk must itself be the frozen EXPECTED_FILES set
    // (guards against fixture tampering making the check vacuous).
    expect(listFilesRecursive(GOLDEN_DIR)).toEqual(EXPECTED_FILES);
    // No extra files, none missing.
    expect(listFilesRecursive(outDir)).toEqual(EXPECTED_FILES);
  });

  it('every produced file equals its golden file byte-for-byte', () => {
    for (const rel of EXPECTED_FILES) {
      const produced = readUtf8(join(outDir, ...rel.split('/')));
      const golden = readUtf8(join(GOLDEN_DIR, ...rel.split('/')));
      expect(produced, `content mismatch for ${rel}`).toBe(golden);
    }
  });

  it('extractPublishDir API exists with the frozen signature (library-level contract)', () => {
    expect(typeof extractPublishDir).toBe('function');
  });
});
