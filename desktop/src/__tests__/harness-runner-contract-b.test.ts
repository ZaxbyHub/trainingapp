/**
 * harness-runner-contract-b.test.ts — issue #216 AC5 (frozen check C5), part B:
 * the four bench harness runners. Part A covers desktop/web_ui runners.
 *
 * Each runner is import-safe (the packaged-smoke entry-guard pattern) and
 * pins its parse/kill/fetch contract. One test per runner, each named
 * `runner-contract: <key>` exactly as the frozen check enumerates.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs as ingestParseArgs,
  main as ingestMain,
} from '../../../bench/ingest_bench_driver.mjs';
import {
  parseArgs as nodeBenchParseArgs,
  main as nodeBenchMain,
} from '../../../bench/node_bench_driver.mjs';
import {
  parseArgs as retrievalParseArgs,
  fetchJson,
  killChildren,
  main as retrievalMain,
} from '../../../bench/retrieval_bench_driver.mjs';
import {
  parseArgs as wllamaParseArgs,
  main as wllamaMain,
  VALUE_FLAGS,
} from '../../../bench/wllama_bench_driver.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

function readRel(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
}

describe('harness runner contracts B (issue #216 AC5)', () => {
  it('runner-contract: ingest_bench_driver is import-safe with a fail-loud parse contract', () => {
    expect(typeof ingestMain).toBe('function');
    expect(() => ingestParseArgs(['--pages', '10'])).not.toThrow();
    expect(ingestParseArgs(['--pages', '10']).pages).toBe(10);
    expect(() => ingestParseArgs(['--pages'])).toThrow(); // bare -> NaN -> required-error
    expect(() => ingestParseArgs([])).toThrow(/--pages is required/);
    expect(() => ingestParseArgs(['--bogus'])).toThrow(/unknown argument/);
    const source = readRel('bench/ingest_bench_driver.mjs');
    expect(source).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
  });

  it('runner-contract: node_bench_driver is import-safe with a fail-loud parse contract', () => {
    expect(typeof nodeBenchMain).toBe('function');
    expect(nodeBenchParseArgs(['--model', 'm', '--gguf', 'g.gguf']).model).toBe('m');
    expect(() => nodeBenchParseArgs(['--model', 'm'])).toThrow(/--gguf is required/);
    expect(() => nodeBenchParseArgs(['--bogus'])).toThrow(/unknown argument/);
    const source = readRel('bench/node_bench_driver.mjs');
    expect(source).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
  });

  it('runner-contract: retrieval_bench_driver pins bounded fetches and wrapper-routed kills', () => {
    expect(typeof retrievalMain).toBe('function');
    expect(typeof fetchJson).toBe('function');
    expect(typeof killChildren).toBe('function');
    expect(retrievalParseArgs(['--queries', '5']).queries).toBe(5);
    expect(() => retrievalParseArgs([])).toThrow(/--queries is required/);
    expect(() => retrievalParseArgs(['--bogus'])).toThrow(/unknown argument/);

    const source = readRel('bench/retrieval_bench_driver.mjs');
    // Every fetch( call site carries a same-line bound (issue #216 AC2).
    const fetchLines = source.split(/\r?\n/).filter((l) => l.includes('fetch('));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) {
      expect(line, `unbounded fetch line: ${line}`).toMatch(/AbortSignal|signal:/);
    }
    // Kills route through the shared wrapper; no raw taskkill (issue #216 AC1).
    expect(source).toContain('killProcessTree');
    expect(source).not.toMatch(/spawnSync\(\s*['"`]taskkill['"`]/);
    expect(source).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
  });

  it('runner-contract: wllama_bench_driver is import-safe with the documented value-flag contract', () => {
    expect(typeof wllamaMain).toBe('function');
    expect([...VALUE_FLAGS].sort()).toEqual(['browser', 'max-tokens', 'model', 'prompt-tokens']);
    // Well-formed parses keep their shape.
    const args = wllamaParseArgs(['--run', '--model', 'm.gguf']);
    expect(args.run).toBe(true);
    expect(args.model).toBe('m.gguf');
    // Bare value flags fail loud (the P6 defect class) — both trigger paths.
    expect(() => wllamaParseArgs(['--run', '--browser'])).toThrow('--browser requires a value');
    expect(() => wllamaParseArgs(['--max-tokens', '--run'])).toThrow('--max-tokens requires a value');
    const source = readRel('bench/wllama_bench_driver.mjs');
    expect(source).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
    // The dead --json usage claim is gone (plan AC4 disposition).
    expect(source).not.toContain('[--json]');
  });
});
