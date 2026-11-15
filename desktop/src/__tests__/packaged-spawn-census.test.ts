// packaged-spawn-census.test.ts — issue #350 Phase 4.2 guardrail (class A).
//
// Defect class: "in-Electron process spawns that assume the parent's Electron
// binary can act as Node" — the packaged runAsNode fuse (deliberate, AC3)
// silently kills any child_process.fork(process.execPath) leg, and the failure
// surfaces as a silent fallback (the #350 CPU-forever shape). The shipped
// desktop code's fork surface is CLOSED by policy: every in-Electron child
// spawn goes through a registered utilityProcess launcher (index.ts) or a
// resolveXxForkFn() that REFUSES inside Electron; the only execPath forks left
// are plain-node legs that are unreachable in the packaged app.
//
// This census VALUE-PINS that surface: a NEW `fork(`/`spawn(process.execPath`
// call site in shipped desktop code (outside the pinned allowlist) fails this
// spec, forcing the author to either register a utilityProcess launcher or
// justify + update the allowlist. Mutant: adding a bare fork() call site must
// fail; deleting an allowlist entry must fail.
//
// The pinned allowlist (shipped-code call sites, r9+ revisions included):
//   - desktop/main/backend/inference/gpu-probe.ts — nodeForkGpuProbe
//     (plain-node leg; resolveGpuProbeForkFn refuses inside Electron),
//     commented references only (docs of the #350/#276 decisions)
//   - desktop/main/backend/ingest/{doc,xlsx,pack}-worker.ts — resolveXxForkFn
//     refusal pattern (registered utilityProcess launcher inside Electron)
//   - desktop/main/index.ts — the registered utilityProcess launchers
// The vendored node-llama-cpp patch (desktop/vendor/) is byte-pinned by C1's
// PRISTINE.sha256 + executed rows, not by this census (node_modules is
// gitignored; the vendor copy is repo-owned and counted separately).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', 'main');

/** Shipped-code spawn call sites, pinned as `file -> count of spawn tokens`. */
const ALLOWLIST: Array<{ file: string; tokens: number }> = [
  { file: 'backend/inference/gpu-probe.ts', tokens: 0 }, // comments + refused launcher; NO raw call site
  { file: 'backend/ingest/doc-worker.ts', tokens: 0 }, // resolveDocWorkerForkFn refusal pattern
  { file: 'backend/ingest/xlsx-worker.ts', tokens: 0 },
  { file: 'backend/packs/pack-worker.ts', tokens: 0 },
  { file: 'index.ts', tokens: 0 }, // registered utilityProcess launchers only
];

const SPAWN_TOKEN_RE = /child_process\.fork\(|spawn\(process\.execPath|fork\(process\.execPath/;

describe('#350 class A guardrail: the shipped execPath-spawn surface stays closed', () => {
  test('the pinned allowlist files still hold their counted spawn tokens (drift both ways)', () => {
    for (const entry of ALLOWLIST) {
      const file = path.join(mainRoot, entry.file);
      expect(fs.existsSync(file), `allowlist file missing: ${entry.file}`).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      const calls = (src.match(/(?:child_process\.fork|spawn|fork)\s*\(\s*process\.execPath/g) ?? []).length;
      expect(
        calls,
        `${entry.file} execPath-spawn call count drifted (pinned ${entry.tokens}, found ${calls}) — a new site needs a registered utilityProcess launcher or an explicit allowlist update with a refusal proof (issue #350 class A)`,
      ).toBe(entry.tokens);
    }
  });

  test('no NEW raw fork/spawn(execPath) call site appears anywhere in shipped desktop main', () => {
    // Walk every .ts under main/ except tests and the pinned allowlist; a
    // matching CALL (not a comment mention) fails.
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const rel = path.relative(mainRoot, full).replace(/\\/g, '/');
        if (ALLOWLIST.some((entry) => entry.file === rel)) continue;
        const src = fs.readFileSync(full, 'utf8');
        // Strip line comments before matching (a prose mention of the pattern
        // in a docstring is not a call site).
        const stripped = src
          .split('\n')
          .map((line) => line.replace(/\/\/.*$/, ''))
          .join('\n');
        if (SPAWN_TOKEN_RE.test(stripped)) violations.push(rel);
      }
    };
    walk(mainRoot);
    expect(
      violations,
      `new raw execPath-spawn call sites must go through a registered utilityProcess launcher or a resolveXxForkFn refusal (issue #350 class A); found: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});
