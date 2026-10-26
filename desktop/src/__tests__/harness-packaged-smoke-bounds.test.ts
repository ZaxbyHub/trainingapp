/**
 * Issue #177 AC-b/AC-c residue pins (harness-contracts workflow surface).
 *
 * The driver's runtime hardening (bounded evaluates/fetches, watchdog) shipped
 * in PR #217/#220 and its behavioral core is already pinned by
 * packaged-smoke-contract.test.ts (fire/suspend/resume/latch, watchdogExit
 * dump-kill-exit, attach summary). This spec pins ONLY the genuinely unpinned
 * residue:
 *   - the SOURCE census: every evaluate flows through boundEvaluate, every
 *     node-side fetch and the in-page /packs fetch carry an abort signal, and
 *     the EVAL_BOUND constants are used at every call site;
 *   - the wall values: job wall 45 and smoke step wall 32 in
 *     desktop-build.yml, plus the docblock/job-45 claim (issue #177 AC9);
 *   - disarm() cancels a PENDING watchdog fire (the latch test covers
 *     fire-then-resume; nothing proved disarmed-before-fire never fires).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { armWatchdog } from '../../scripts/packaged-smoke.mjs';

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

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(THIS_DIR);
const SMOKE_PATH = path.join(REPO_ROOT, 'desktop', 'scripts', 'packaged-smoke.mjs');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'desktop-build.yml');

const readRel = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');

describe('harness-packaged-smoke-bounds (issue #177)', () => {
  it('smoke-bounds-census: every evaluate is boundEvaluate-routed and every fetch carries an abort signal', () => {
    const src = readRel('desktop/scripts/packaged-smoke.mjs');

    // (a) The ONLY raw evaluate site is the boundEvaluate helper definition.
    const rawEvaluateLines = src
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\.evaluate\(/.test(line) && !/boundEvaluate/.test(line));
    expect(
      rawEvaluateLines.map(({ line, index }) => `${index + 1}: ${line.trim()}`),
      'every evaluate must flow through boundEvaluate (the helper definition line is the single raw site)',
    ).toEqual([]);

    // (b) The helper exists exactly once and routes through withTimeout.
    const helperDefs = src.split(/\r?\n/).filter((l) => /export const boundEvaluate = /.test(l));
    expect(helperDefs).toHaveLength(1);
    expect(helperDefs[0]).toContain('withTimeout');

    // (c) Every node-side fetch( carries signal: (the readiness probes). The
    //     in-page /packs fetch opens on its own line with the signal on the
    //     next (renderer-side block, pinned separately in (d)).
    const nodeFetchLines = src
      .split(/\r?\n/)
      .filter((l) => /(?<!\.)\bfetch\(/.test(l))
      .filter((l) => !/AbortSignal/.test(l))
      .filter((l) => !/`\$\{info\.url\}\/packs`/.test(l));
    expect(
      nodeFetchLines,
      `node-side fetch without AbortSignal: ${nodeFetchLines.join(' | ')}`,
    ).toEqual([]);

    // (d) The in-page /packs fetch carries its own timeout (issue #177 AC-b
    //     hardening: bounded even inside the evaluate race); the signal sits
    //     on the options object line(s) after the fetch( itself.
    const packsProbeBlock = src.slice(src.indexOf('/packs must answer 200'));
    expect(packsProbeBlock.length).toBeGreaterThan(0);
    const probeLines = packsProbeBlock.split(/\r?\n/);
    const fetchIdx = probeLines.findIndex((l) => l.includes('fetch('));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    const fetchWindow = probeLines.slice(fetchIdx, fetchIdx + 4).join('\n');
    expect(fetchWindow).toContain('AbortSignal.timeout');

    // (e) The EVAL_BOUND constants exist and every boundEvaluate call site
    //     names one (no ad-hoc unbounded race anywhere).
    expect(src).toMatch(/const EVAL_BOUND_[A-Z_]+ = \d/);
    const callSites = src.split(/\r?\n/).filter((l) => /boundEvaluate\(/.test(l) && !/export const/.test(l));
    // 4 direct sites today (close-path, both ladder drivers, desktopApi probe);
    // the CDP-session ladder routes through the session.run indirection on top
    // of the ladder-driver site.
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    for (const site of callSites) {
      // The close-path site takes closeEvalMs, whose default IS
      // EVAL_BOUND_CLOSE_MS (closeCdpSession's parameter default).
      expect(site).toMatch(/EVAL_BOUND_[A-Z_]+|closeEvalMs/);
    }
  });

  it('smoke-bounds-census: the workflow and docblock walls state their real values (issue #177 AC9)', () => {
    const workflow = readRel('.github/workflows/desktop-build.yml');
    // Job wall: 45, and its own comment names 45 (the stale-comment drift
    // this AC closes).
    const jobWall = workflow.match(/timeout-minutes: (\d+)/);
    expect(jobWall).not.toBeNull();
    expect(Number(jobWall![1])).toBe(45);
    const jobComment = workflow.slice(0, jobWall!.index ?? 0);
    expect(jobComment).toMatch(/# 45 gives the ~8-min build prefix/);

    // Smoke step wall: 32 (step-level), below the job wall.
    const smokeStep = workflow.slice(workflow.indexOf('Packaged-boot smoke'));
    const stepWall = smokeStep.match(/timeout-minutes: (\d+)/);
    expect(stepWall).not.toBeNull();
    expect(Number(stepWall![1])).toBe(32);

    // The watchdog docblock states the job wall it must fire under.
    const src = readRel('desktop/scripts/packaged-smoke.mjs');
    expect(src).toMatch(/the smoke step carries timeout-minutes 32 and the job\s*\n?\s*\*? ?45/);
  });

  it('smoke-watchdog-disarm: disarm cancels a PENDING fire and latches against resume', async () => {
    let fired = 0;
    const wd = armWatchdog(400, { fire: () => { fired += 1; } });
    wd.disarm();
    // Longer than the full original budget: a disarmed watchdog never fires,
    // and resume() after disarm cannot re-arm (the latch covers disarm too).
    wd.resume();
    await new Promise((r) => setTimeout(r, 550));
    expect(fired).toBe(0);
  });
});
