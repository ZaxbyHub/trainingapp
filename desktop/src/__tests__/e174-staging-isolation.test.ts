/**
 * e174-staging-isolation.test.ts — issue #174 AC1 (frozen check C9,
 * `staging-isolation-concurrent`).
 *
 * The shared installer-resource staging tree used to have NO serialization:
 * stage-installer-resources.mjs wiped and copied directly, and
 * build-installer-manifest.mjs wrote manifest.json into the same tree — two
 * overlapping runs on one machine interleaved silently. The fix is an
 * exclusive staging lock (desktop/scripts/staging-lock.mjs) held by BOTH
 * writers, acquired BEFORE the first destructive wipe, with a loud named
 * refusal (STAGING_LOCK_HELD) for the contender.
 *
 * Three hermetic evidence layers (plan D5′, plan-critic rounds 2-4):
 *   1. lock-helper unit tests (tmp dirs): acquire/contend/release, failure-path
 *      release, async-body release timing, foreign-pid release refusal;
 *   2. generator CLI contention with a deterministic self-held lock (tmp staged
 *      tree): refusal while held, success after release;
 *   3. REAL stager against a minimal TEMPORARY REPOSITORY REPLICA: the script
 *      is copied into <tmp>/desktop/scripts/ so every output (stage tree, its
 *      sibling lock, dist/contracts) lands inside the replica by construction;
 *      the probe proves refusal happens BEFORE any wipe (canary intact), then
 *      success after release, and that nothing outside the replica was touched.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireStagingLock,
  releaseStagingLock,
  stagingLockPathFor,
  StagingLockHeld,
  withStagingLockSync,
} from '../../scripts/staging-lock.mjs';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(`repo root not found above ${dir} (marker walk hit checkout root)`);
    }
    current = path.dirname(current);
  }
  throw new Error(`repo root not found above ${dir}`);
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = path.join(REPO_ROOT, 'desktop', 'scripts');
const REAL_CONTRACTS_OUT = path.join(REPO_ROOT, 'desktop', 'dist', 'contracts');

const spawnNode = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
      },
    );
  });

const copyRecursive = (from: string, to: string): void => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
  } else {
    fs.copyFileSync(from, to);
  }
};

describe('staging lock helper (issue #174 AC1)', () => {
  it('staging-isolation-concurrent: contending acquire refuses with STAGING_LOCK_HELD, release re-arms', ({ }) => {
    const stage = fs.mkdtempSync(path.join(import.meta.dirname!, 'lock-'));
    try {
      const lockPath = acquireStagingLock(stage);
      expect(lockPath).toBe(stagingLockPathFor(stage));
      expect(fs.existsSync(lockPath)).toBe(true);
      const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(Number(holder.pid)).toBe(process.pid);

      let thrown: unknown = null;
      try {
        acquireStagingLock(stage);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StagingLockHeld);
      const held = thrown as StagingLockHeld;
      expect(held.code).toBe('STAGING_LOCK_HELD');
      expect(held.message).toContain('STAGING_LOCK_HELD');
      expect(String((held.holder as { pid: unknown }).pid)).toBe(String(process.pid));

      expect(releaseStagingLock(stage)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
      // Re-acquire after release succeeds (serialization, not one-shot).
      expect(() => acquireStagingLock(stage)).not.toThrow();
      releaseStagingLock(stage);
    } finally {
      releaseStagingLock(stage);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(stagingLockPathFor(stage), { force: true });
    }
  });

  it('staging-isolation-concurrent: withStagingLockSync releases on success, throw, and after an async body settles', async () => {
    const stage = fs.mkdtempSync(path.join(import.meta.dirname!, 'lock-'));
    try {
      withStagingLockSync(stage, () => 'ok');
      expect(fs.existsSync(stagingLockPathFor(stage))).toBe(false);

      expect(() =>
        withStagingLockSync(stage, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(fs.existsSync(stagingLockPathFor(stage))).toBe(false);

      let settled = false;
      await withStagingLockSync(stage, async () => {
        await new Promise((r) => setTimeout(r, 30));
        settled = true;
      });
      expect(settled).toBe(true);
      // The lock is released AFTER the async body settles, never before.
      expect(fs.existsSync(stagingLockPathFor(stage))).toBe(false);

      // A foreign holder's lock is never unlinked by a bystander release.
      const lockPath = stagingLockPathFor(stage);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, since: 'stale' }), 'utf8');
      expect(releaseStagingLock(stage)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      fs.rmSync(lockPath, { force: true });
    } finally {
      releaseStagingLock(stage);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(stagingLockPathFor(stage), { force: true });
    }
  });
});

describe('manifest generator contention (issue #174 AC1)', () => {
  it('staging-isolation-concurrent: self-held lock refuses the generator, release admits it', async () => {
    const stage = fs.mkdtempSync(path.join(import.meta.dirname!, 'gen-'));
    fs.mkdirSync(path.join(stage, 'models', 'llm-fast', 'm'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'models', 'llm-fast', 'm', 'a.txt'), 'x'.repeat(64));
    const generator = path.join(SCRIPTS, 'build-installer-manifest.mjs');
    const argv = ['--stage-dir', stage, '--out', path.join(stage, 'manifest.json')];
    try {
      acquireStagingLock(stage);
      const held = await spawnNode([generator, ...argv]);
      expect(held.code).not.toBe(0);
      expect(held.stderr).toContain('STAGING_LOCK_HELD');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);

      releaseStagingLock(stage);
      const ok = await spawnNode([generator, ...argv]);
      expect(ok.code).toBe(0);
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(true);
    } finally {
      releaseStagingLock(stage);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(stagingLockPathFor(stage), { force: true });
    }
  });
});

describe('real stager against a temporary replica (issue #174 AC1)', () => {
  let replica = '';
  let realContractMtimesBefore: Record<string, number> = {};

  const buildReplica = (): string => {
    const root = fs.mkdtempSync(path.join(import.meta.dirname!, 'replica-'));
    fs.mkdirSync(path.join(root, 'desktop', 'scripts'), { recursive: true });
    // The REAL script, copied: its ROOT derives from import.meta.url, so the
    // stage tree, its sibling lock, and dist/contracts all land in the replica.
    fs.copyFileSync(path.join(SCRIPTS, 'stage-installer-resources.mjs'), path.join(root, 'desktop', 'scripts', 'stage-installer-resources.mjs'));
    fs.copyFileSync(path.join(SCRIPTS, 'staging-lock.mjs'), path.join(root, 'desktop', 'scripts', 'staging-lock.mjs'));
    // Fresh renderer; web_ui/dist ABSENT → renderer freshness takes its pinned
    // deterministic no-dist pass path (i173-renderer-freshness.test.ts:145-161).
    fs.mkdirSync(path.join(root, 'desktop', 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), '<html></html>');
    // Tracked source inputs the stager reads (fixture models need no weights).
    copyRecursive(path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs', 'bundled-min'), path.join(root, 'contracts', 'fixtures', 'packs', 'bundled-min'));
    for (const rel of ['contracts/store.schema.sql', 'contracts/pack.schema.json', 'contracts/pack-feed.schema.json']) {
      copyRecursive(path.join(REPO_ROOT, ...rel.split('/')), path.join(root, ...rel.split('/')));
    }
    for (const rel of ['docs/licenses.md', 'docs/licenses/LFM-OPEN-LICENSE-v1.0.txt']) {
      copyRecursive(path.join(REPO_ROOT, ...rel.split('/')), path.join(root, ...rel.split('/')));
    }
    // Canary inside the stage tree: the refusal must fire BEFORE the wipe.
    fs.mkdirSync(path.join(root, 'desktop', 'installer-resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'desktop', 'installer-resources', 'canary.txt'), 'do not wipe while locked');
    return root;
  };

  beforeAll(() => {
    replica = buildReplica();
    realContractMtimesBefore = {};
    for (const entry of fs.existsSync(REAL_CONTRACTS_OUT) ? fs.readdirSync(REAL_CONTRACTS_OUT) : []) {
      realContractMtimesBefore[entry] = fs.statSync(path.join(REAL_CONTRACTS_OUT, entry)).mtimeMs;
    }
  });

  afterAll(() => {
    // Review round: NEVER touch the real checkout's lock file (a live build
    // may hold it - deleting it would destroy the mutual exclusion this PR
    // installs). Replica cleanup only.
    fs.rmSync(replica, { recursive: true, force: true });
  });

  it('staging-isolation-concurrent: held-lock refusal precedes the wipe; release admits a full run; zero writes outside the replica', { timeout: 120_000 }, async () => {
    const replicaStage = path.join(replica, 'desktop', 'installer-resources');
    const stager = path.join(replica, 'desktop', 'scripts', 'stage-installer-resources.mjs');
    const argv = ['--fixture-models', '--skip-renderer-copy'];

    // 1. Refusal BEFORE any destructive work: the canary survives.
    acquireStagingLock(replicaStage);
    try {
      const held = await spawnNode([stager, ...argv]);
      expect(held.code).toBe(1);
      expect(held.stderr).toContain('STAGING_LOCK_HELD');
      expect(fs.readFileSync(path.join(replicaStage, 'canary.txt'), 'utf8')).toContain('do not wipe');
      expect(fs.existsSync(path.join(replicaStage, 'models'))).toBe(false);
    } finally {
      releaseStagingLock(replicaStage);
    }

    // 2. After release the real stager completes end-to-end in the replica.
    const ok = await spawnNode([stager, ...argv]);
    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('staging complete');
    expect(fs.existsSync(path.join(replicaStage, 'models', 'llm-fast', 'lfm2-1.2b-rag', 'model.gguf'))).toBe(true);
    expect(fs.existsSync(path.join(replicaStage, 'packs'))).toBe(true);
    expect(fs.existsSync(path.join(replica, 'desktop', 'dist', 'contracts', 'store.schema.sql'))).toBe(true);

    // 3. Zero writes outside the replica: the real checkout's staged
    //    contracts were never touched. (The real lock file is deliberately
    //    NOT asserted or deleted - machine state, review round.)
    for (const [entry, before] of Object.entries(realContractMtimesBefore)) {
      expect(fs.statSync(path.join(REAL_CONTRACTS_OUT, entry)).mtimeMs).toBe(before);
    }

    // 4. Structural pins: both writers hold the SAME lock around their critical
    //    sections, via the shared helper, and the stager's exit no longer
    //    bypasses the release (no process.exit inside the locked region).
    const stagerSrc = fs.readFileSync(path.join(SCRIPTS, 'stage-installer-resources.mjs'), 'utf8');
    const generatorSrc = fs.readFileSync(path.join(SCRIPTS, 'build-installer-manifest.mjs'), 'utf8');
    expect(stagerSrc).toContain('withStagingLockSync(stageDir');
    expect(generatorSrc).toContain('withStagingLockSync(stage');
    expect(stagerSrc).toContain("from './staging-lock.mjs'");
    const stagerLockedBody = stagerSrc.slice(stagerSrc.indexOf('withStagingLockSync(stageDir'));
    expect(stagerLockedBody).not.toMatch(/process\.exit\(/);
  });
});
