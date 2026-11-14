/**
 * build-offline wrapper tests (issue #272 AC1 / frozen check C7).
 *
 * Drives the PRODUCTION orchestration path — main(argv, deps) with an
 * injected spawnSync (the airgapMain pattern) — so a wrapper whose planner
 * handles flags but whose main discards arguments FAILS this spec. Asserts:
 * per-flag and combined argv of prepare-models AND validate-build; that
 * prepare-packs and build never receive flags; chain stop on failure;
 * unknown-flag exit 2.
 *
 * @vitest-environment node
 */

import { describe, test, expect, vi } from 'vitest';
import { offlineSteps, main, parseArgs } from './build-offline.mjs';

interface SpawnCall {
  command: string;
  args: string[];
}

function fakeSpawn(returnStatus = 0) {
  const calls: SpawnCall[] = [];
  const impl = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: returnStatus };
  };
  (impl as typeof impl & { calls: SpawnCall[] }).calls = calls;
  return impl as typeof impl & { calls: SpawnCall[] };
}

describe('parseArgs', () => {
  test('collects known model flags in order and rejects unknown ones', () => {
    expect(parseArgs(['--no-llm', '--no-embedder'])).toEqual({
      flags: ['--no-llm', '--no-embedder'],
      error: null,
    });
    const bad = parseArgs(['--llm']);
    expect(bad.error).toContain('unknown flag: --llm');
  });
});

describe('offlineSteps', () => {
  test('forwards flags ONLY to prepare-models and validate-build; ordering matches the base chain', () => {
    const steps = offlineSteps({ flags: ['--no-llm'] });
    expect(steps.map((s) => s.name)).toEqual([
      'prepare-models',
      'prepare-packs',
      'build',
      'validate-build',
    ]);
    expect(steps[0].args).toContain('--no-llm');
    expect(steps[1].args).toEqual(['scripts/prepare-packs.mjs']);
    expect(steps[2].args).toEqual(['run', 'build']);
    expect(steps[3].args).toContain('--no-llm');
  });

  test('default argv (no flags) matches the base four-step chain flag-free', () => {
    const steps = offlineSteps({});
    for (const step of steps) {
      expect(step.args.some((a) => a.startsWith('--no-'))).toBe(false);
    }
  });
});

describe('main (production orchestration path, injected spawn)', () => {
  test('forwards --no-llm to prepare-models and validate-build argv and NOT to prepare-packs/build', () => {
    const spawn = fakeSpawn();
    const rc = main(['--no-llm'], { spawnSyncImpl: spawn });
    expect(rc).toBe(0);
    expect(spawn.calls).toHaveLength(4);
    expect(spawn.calls[0].args).toContain('--no-llm');
    expect(spawn.calls[0].args[0]).toMatch(/prepare-models\.mjs$/);
    expect(spawn.calls[1].args).toEqual(['scripts/prepare-packs.mjs']);
    expect(spawn.calls[2].args).toEqual(['run', 'build']);
    expect(spawn.calls[3].args).toContain('--no-llm');
    expect(spawn.calls[3].args[0]).toMatch(/validate-build\.mjs$/);
  });

  test('forwards each flag and their combination to exactly the two model steps', () => {
    for (const flags of [['--no-reranker'], ['--no-embedder'], ['--no-llm', '--no-embedder']]) {
      const spawn = fakeSpawn();
      const rc = main(flags, { spawnSyncImpl: spawn });
      expect(rc).toBe(0);
      expect(spawn.calls[0].args.slice(1)).toEqual(flags);
      expect(spawn.calls[3].args.slice(1)).toEqual(flags);
      expect(spawn.calls[1].args).not.toContain(flags[0]);
      expect(spawn.calls[2].args).not.toContain(flags[0]);
    }
  });

  test('stops the chain on the first failing step and returns its status', () => {
    const spawn = fakeSpawn(3);
    const rc = main([], { spawnSyncImpl: spawn });
    expect(rc).toBe(3);
    expect(spawn.calls).toHaveLength(1); // prepare-models failed; chain stopped
  });

  test('rejects an unknown flag with exit 2 without spawning anything', () => {
    const spawn = fakeSpawn();
    const rc = main(['--llm'], { spawnSyncImpl: spawn });
    expect(rc).toBe(2);
    expect(spawn.calls).toHaveLength(0);
  });
});
