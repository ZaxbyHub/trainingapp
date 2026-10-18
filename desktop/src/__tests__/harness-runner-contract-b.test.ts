/**
 * harness-runner-contract-b.test.ts — issue #216 AC5 (frozen check C5), part B:
 * the four bench harness runners. Part A covers desktop/web_ui runners.
 *
 * Each runner is import-safe (the packaged-smoke entry-guard pattern) and
 * pins its parse/kill/fetch contract. Each runner's core contract test is
 * named `runner-contract: <key>` exactly as the frozen check enumerates;
 * node_bench_driver carries two extra issue-#221 flag-validation tests under
 * the same key prefix.
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

  it('runner-contract: node_bench_driver node-bench-flags-validate rejects non-integer, NaN, and sub-1 values', async () => {
    // Issue #221 AC2: a present but non-numeric or non-positive value fails
    // loud — it must never flow NaN into the row or prompt sizing. Full
    // matrix: every invalid class on every flag, so a per-flag divergence in
    // readPositiveInt cannot survive. The hex/exponent/padded spellings pin
    // the decimal-only grammar (PR #222 review PRR-002).
    for (const flag of ['--threads', '--max-tokens', '--prompt-tokens']) {
      for (const bad of ['abc', 'NaN', '1.5', '0', '-1', '0x10', '1e3', ' 8']) {
        expect(() => nodeBenchParseArgs(['--model', 'm', '--gguf', 'g', flag, bad])).toThrow(
          `${flag} must be a positive integer`,
        );
      }
    }
    // A parse failure resolves main() with 2 (never rejects): the exit-2
    // contract pinned without spawning a process (PR #222 review PRR-004).
    const origArgv = process.argv;
    try {
      process.argv = [process.execPath, 'node_bench_driver.mjs', '--model', 'm', '--gguf', 'g', '--threads', 'abc'];
      await expect(nodeBenchMain()).resolves.toBe(2);
    } finally {
      process.argv = origArgv;
    }
  });

  it('runner-contract: node_bench_driver node-bench-flags-defaults keeps documented defaults and explicit values', () => {
    // Issue #221 AC3: absent numeric flags keep their documented defaults
    // (8/128/64); explicit positive integers are taken as-is.
    const defaults = nodeBenchParseArgs(['--model', 'm', '--gguf', 'g']);
    expect(defaults.threads).toBe(8);
    expect(defaults['max-tokens']).toBe(128);
    expect(defaults['prompt-tokens']).toBe(64);
    const explicit = nodeBenchParseArgs(['--model', 'm', '--gguf', 'g', '--threads', '4', '--max-tokens', '256', '--prompt-tokens', '32']);
    expect(explicit.threads).toBe(4);
    expect(explicit['max-tokens']).toBe(256);
    expect(explicit['prompt-tokens']).toBe(32);
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
