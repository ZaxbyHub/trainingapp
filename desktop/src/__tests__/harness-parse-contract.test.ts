/**
 * harness-parse-contract.test.ts — issue #216 AC4 (frozen check C4).
 *
 * Pins the fail-loud semantics for the five P6 valueless-flag sites: a
 * value-requiring flag present without a value fails loud (never a silent
 * default), while documented boolean flags and documented absent-flag defaults
 * keep their semantics. One test per site; every name carries the frozen
 * `parse-missing-value` filter.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs as wllamaParseArgs,
  VALUE_FLAGS,
  BOOLEAN_FLAGS,
} from '../../../bench/wllama_bench_driver.mjs';
import {
  resolveVersionArgv as resolveKnowledgePackVersion,
  DEFAULT_PACK_VERSION as KNOWLEDGE_DEFAULT,
} from '../../../desktop/scripts/build-knowledge-pack.mjs';
import {
  resolveVersionArgv as resolveTrainingPackVersion,
  resolvePublishArgv as resolveTrainingPackPublish,
  DEFAULT_PACK_VERSION as TRAINING_DEFAULT,
} from '../../../desktop/scripts/build-training-pack.mjs';

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

describe('harness parse contract (issue #216 AC4)', () => {
  it('parse-missing-value: wllama bare value flags fail loud at end of argv and before another flag', () => {
    // Trigger path 1: bare value flag at end-of-argv.
    expect(() => wllamaParseArgs(['--run', '--model'])).toThrow('--model requires a value');
    expect(() => wllamaParseArgs(['--prompt-tokens'])).toThrow('--prompt-tokens requires a value');
    expect(() => wllamaParseArgs(['--max-tokens'])).toThrow('--max-tokens requires a value');
    expect(() => wllamaParseArgs(['--browser'])).toThrow('--browser requires a value');
    // Trigger path 2: bare value flag before another flag (the parseInt(true) NaN shape).
    expect(() => wllamaParseArgs(['--model', '--run'])).toThrow('--model requires a value');
    expect(() => wllamaParseArgs(['--prompt-tokens', '--max-tokens', '16'])).toThrow('--prompt-tokens requires a value');
  });

  it('parse-missing-value: build-knowledge-pack bare --version fails loud and the default is documented', () => {
    expect(() => resolveKnowledgePackVersion(['--version'])).toThrow('--version requires a value');
    expect(() => resolveKnowledgePackVersion(['--version', '--other'])).toThrow('--version requires a value');
    // Absent flag keeps the documented default; a valued flag is taken as-is.
    expect(resolveKnowledgePackVersion([])).toBe(KNOWLEDGE_DEFAULT);
    expect(KNOWLEDGE_DEFAULT).toBe('1.0.0');
    expect(resolveKnowledgePackVersion(['--version', '2.0.0'])).toBe('2.0.0');
    // CLI-level fail-loud: a bare --version exits 2 before any build work.
    const script = path.join(REPO_ROOT, 'desktop', 'scripts', 'build-knowledge-pack.mjs');
    const res = spawnSync(process.execPath, [script, '--version'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--version requires a value');
  });

  it('parse-missing-value: build-training-pack bare --version fails loud and the default is documented', () => {
    expect(() => resolveTrainingPackVersion(['--version'])).toThrow('--version requires a value');
    expect(() => resolveTrainingPackVersion(['--version', '--publish'])).toThrow('--version requires a value');
    expect(resolveTrainingPackVersion([])).toBe(TRAINING_DEFAULT);
    expect(TRAINING_DEFAULT).toBe('1.0.1');
    expect(resolveTrainingPackVersion(['--version', '1.2.3'])).toBe('1.2.3');
    const script = path.join(REPO_ROOT, 'desktop', 'scripts', 'build-training-pack.mjs');
    const res = spawnSync(process.execPath, [script, '--version'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--version requires a value');
  });

  it('parse-missing-value: build-training-pack bare --publish fails loud and the default chain is documented', () => {
    expect(() => resolveTrainingPackPublish(['--publish'])).toThrow('--publish requires a value');
    expect(() => resolveTrainingPackPublish(['--publish', '--version'])).toThrow('--publish requires a value');
    // Absent flag resolves to undefined so env/DEFAULT_PUBLISH apply downstream.
    expect(resolveTrainingPackPublish([])).toBeUndefined();
    expect(resolveTrainingPackPublish(['--publish', 'D:/course'])).toBe('D:/course');
    const script = path.join(REPO_ROOT, 'desktop', 'scripts', 'build-training-pack.mjs');
    const res = spawnSync(process.execPath, [script, '--publish'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--publish requires a value');
  });

  it('parse-missing-value: wllama boolean flags keep documented bare semantics', () => {
    expect([...BOOLEAN_FLAGS].sort()).toEqual(['chat', 'list-modes', 'run']);
    expect([...VALUE_FLAGS].sort()).toEqual(['browser', 'max-tokens', 'model', 'prompt-tokens']);
    const args = wllamaParseArgs(['--run', '--chat', '--list-modes']);
    expect(args.run).toBe(true);
    expect(args.chat).toBe(true);
    expect(args['list-modes']).toBe(true);
    // A well-formed value flag still takes its value.
    const valued = wllamaParseArgs(['--model', 'm.gguf', '--prompt-tokens', '64']);
    expect(valued.model).toBe('m.gguf');
    expect(valued['prompt-tokens']).toBe('64');
  });
});
