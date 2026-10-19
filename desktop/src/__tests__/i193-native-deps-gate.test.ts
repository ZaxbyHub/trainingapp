// i193-native-deps-gate.test.ts — pins the recorded D2 skip-vs-fail policy
// for native-deps-gated suites (issue #193 AC1's executed outcome, trace
// test-batch-oct2026 Cluster A) AND the wiring that delivers it.
//
// Decision D2 (recorded on #193 before implementation): missing native deps
// FAIL under CI (silent CI skips are the silent-degrade class this batch
// exists to kill) and SKIP locally (the repo's sanctioned staged-deps skip).
// The predicate lives in ./fixtures/native-deps-gate.ts and is consumed by
// i169-stats-route-real-seed.test.ts's describeReal gate.
//
// The WIRING rows (second describe) exist because the first review round
// observed the gate unreachable: the store stack top-level-required the
// native addon, so a deps-less box died at MODULE_NOT_FOUND before any
// skip/fail decision could run. They pin (a) the lazy-require shape that
// keeps the stack import-safe and (b) the end-to-end branch behavior via a
// nested run of the gated spec with TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeDepsGate, NATIVE_DEPS_SKIP_MARKER, STAGING_INSTRUCTION } from './fixtures/native-deps-gate.js';

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

describe('native-deps-gate policy (issue #193 D2: CI fails, local skips)', () => {
  it('deps present -> run, regardless of CI', () => {
    expect(nativeDepsGate({ ci: false, nativeDepsPresent: true })).toBe('run');
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: true })).toBe('run');
  });

  it('deps missing under CI -> fail (never a silent skip)', () => {
    // The AC21 named mutant inverts this branch (fail -> skip); this row is
    // what must go red.
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: false })).toBe('fail');
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: false })).not.toBe('skip');
  });

  it('deps missing locally -> skip (the sanctioned staged-deps skip)', () => {
    expect(nativeDepsGate({ ci: false, nativeDepsPresent: false })).toBe('skip');
  });
});

describe('native-deps-gate WIRING (issue #193 AC21: the gate must be reachable)', () => {
  it('store stack is import-safe: native addons resolve lazily, never at module import', () => {
    // Named mutant: restore a top-level native require/import in any of these
    // files — this row must go red. The shapes covered: the CJS spelling AND
    // the ESM spellings (this package is `"type": "module"`, so a real revert
    // would compile to an import, including the awaited dynamic form). (The empirical twin is the hide-deps
    // transcript in the trace: with the addon absent the gated spec loads and
    // skips instead of dying at MODULE_NOT_FOUND.)
    const topLevelRequire = [
      /^const\s+\w+\s*=\s*require\(['"](?:better-sqlite3|sqlite-vec)['"]\)/m,
      /^import\s+[^\n]*from\s+['"](?:better-sqlite3|sqlite-vec)['"]/m,
      /^import\s*\(\s*['"](?:better-sqlite3|sqlite-vec)['"]\s*\)/m,
      /await\s+import\(\s*['"](?:better-sqlite3|sqlite-vec)['"]\s*\)/m,
    ];
    const lazyMarkers: Array<[string, string]> = [
      ['desktop/main/backend/store/sqlite-store.ts', 'function loadNativeAddons'],
      ['desktop/main/backend/store/recovery.ts', 'function rawDatabase'],
      ['desktop/main/backend/store/backup.ts', 'function rawDatabase'],
      ['desktop/main/backend/store/pack-manager.ts', 'function loadNativeIndexAddons'],
    ];
    for (const [rel, marker] of lazyMarkers) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(source, `${rel} lost its lazy native loader`).toContain(marker);
      expect(source, `${rel} top-level-requires a native addon`).not.toMatch(topLevelRequire[0]);
      expect(source, `${rel} top-level-imports a native addon`).not.toMatch(topLevelRequire[1]);
      expect(source, `${rel} top-level-dynamic-imports a native addon`).not.toMatch(topLevelRequire[2]);
      expect(source, `${rel} await-imports a native addon`).not.toMatch(topLevelRequire[3]);
    }
  });

  it('wiring: forced-absent locally SKIPS the real suite with the staging instruction', () => {
    // Named mutant: make describeReal plain `describe` (drop the skip
    // wiring) — the nested real rows then run without a store and the run
    // exits nonzero, so this row must go red.
    const env = { ...process.env, TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1' };
    delete env.CI;
    const result = spawnSync(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      { shell: true, cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(out, out).toContain(NATIVE_DEPS_SKIP_MARKER);
    expect(out, out).toContain(STAGING_INSTRUCTION);
    expect(result.status, out).toBe(0);
    // The non-native AC15 row keeps running on a deps-less box.
    expect(out, out).toMatch(/[1-9][0-9]* passed/);
    expect(out, out).toMatch(/out-of-scope-fields/);
  });

  it('wiring: forced-absent under CI FAILS loudly with the staging instruction', () => {
    // Named mutant: delete the fail-branch throw in i169's suite-scoped
    // beforeAll — the nested run then degrades to row failures without the
    // instruction, so this row must go red.
    const env = {
      ...process.env,
      TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1',
      CI: '1',
    };
    const result = spawnSync(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      { shell: true, cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    // Exclude the null status (review PRR-006): spawnSync reports
    // status: null on timeout or signal death, which would satisfy a bare
    // not.toBe(0) — a killed run must never read as the loud failure.
    expect(result.status, out).not.toBeNull();
    expect(result.status, out).not.toBe(0);
    expect(out, out).toContain('native deps missing under CI');
    expect(out, out).toContain('fail, never silently skip');
    expect(out, out).toContain(STAGING_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// Issue #203 AC3 (batch-143-203-204-212-213-215): the structural adoption net.
// Every native-deps gate in the corpus goes through the shared factory in
// ./fixtures/native-deps-gate.ts — no private presence probe and no bare
// skip-gate ternary anywhere else. Named mutants: revert one migrated suite
// to the bare ternary, rename/bypass the factory call, or move the probe out
// of the fixture — this row must go red.
// ---------------------------------------------------------------------------
describe('native-deps gate ADOPTION (issue #203)', () => {
  it('gate-adoption-scan: the shared factory owns every native-deps gate', () => {
    const scanRoot = path.join(REPO_ROOT, 'desktop', 'src', '__tests__');
    const stripCommentsForScan = (source: string): string => {
      let out = '';
      let i = 0;
      let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'template' = 'code';
      while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (state === 'code') {
          if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
          if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
          if (c === "'" || c === '"' || c === '`') {
            state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'template';
            out += c; i += 1; continue;
          }
          out += c; i += 1; continue;
        }
        if (state === 'line') {
          if (c === '\n') { state = 'code'; out += c; }
          i += 1; continue;
        }
        if (state === 'block') {
          if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
          if (c === '\n') out += c;
          i += 1; continue;
        }
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        out += c;
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'template' && c === '`')) {
          state = 'code';
        }
        i += 1;
      }
      return out;
    };
    const policyHome = 'fixtures/native-deps-gate.ts';
    const netHome = 'i193-native-deps-gate.test.ts';
    // Skip-gate ternary exemption (outbound-guardrail allowlist pattern):
    // b4-llama-engine's REAL_FAST_MODEL gate is a deliberately-unstaged
    // devstation-only real-model artifact group (failing under CI would redden
    // every run permanently; its inline guard names the exact missing
    // artifact). Dispositioned in the batch's Phase 4.2 sweep (P2).
    const ternaryExempt = new Map<string, string>([
      ['b4-llama-engine.test.ts', 'REAL_FAST_MODEL devstation-only real-model gate (deliberately unstaged artifact)'],
    ]);
    const gateTernary =
      /\?\s*(?:it|describe)(?:\.skip)?\s*:\s*(?:it|describe)\.skip\b|\?\s*(?:it|describe)\.skip\s*:\s*(?:it|describe)\b/;
    // Bare it.skip/describe.skip token ban (reviewer round-1 finding: an
    // indirect `if (!existsSync(...)) itReal = it.skip` gate carries no flag
    // token, no probed addon name, and no ternary — the token ban is the
    // clause that catches it). it.skipIf is vitest's VISIBLE conditional skip
    // and is deliberately allowed (it shows in the runner counts).
    // PRR-017: the token ban covers the aliases and bracket forms too, and
    // the skipIf composition with an existence probe (a visible-form skip
    // hiding a presence gate) is banned outright.
    const skipToken = /\b(?:it|describe|test|suite)\.skip\b|\b(?:it|describe|test|suite)\s*\[\s*['"]skip/;
    const skipIfProbe = /\bskipIf\s*\([^)]*existsSync/;
    // Also bans calling the exported nativeDepsPresent probe from a suite
    // (e.g. it.skipIf(!nativeDepsPresent())(...) is a silent-skip gate in a
    // visible-form disguise); only the factory may consult the probe.
    const probeConstruction = /\bNATIVE_DEPS_PRESENT\b|fs\.existsSync\([^)]*better-sqlite3|\bnativeDepsPresent\s*\(/;
    const factoryUse = /\bnativeDeps(?:It|DescribeGroup|Decision|Present)\s*\(/;
    const offenders: string[] = [];

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(scanRoot);

    for (const file of files.sort()) {
      const rel = path.relative(scanRoot, file).split(path.sep).join('/');
      if (rel === policyHome || rel === netHome) continue;
      // Comment-stripped with a state machine (strings kept): a comment may
      // quote the bare-gate shape while documenting it, and a naive block
      // strip would swallow code at glob text like `main/**`.
      const source = stripCommentsForScan(fs.readFileSync(file, 'utf8'));
      if (probeConstruction.test(source)) {
        offenders.push(`${rel}: constructs the native-deps presence probe (use the factory)`);
      }
      if (gateTernary.test(source)) {
        const reason = ternaryExempt.get(rel);
        if (reason === undefined) {
          offenders.push(`${rel}: bare skip-gate ternary (use nativeDepsIt / nativeDepsDescribeGroup)`);
        }
      }
      if (skipToken.test(source) && !ternaryExempt.has(rel)) {
        offenders.push(
          `${rel}: bare it.skip/describe.skip outside the factory (use nativeDepsIt / nativeDepsDescribeGroup)`,
        );
      }
      if (skipIfProbe.test(source)) {
        offenders.push(`${rel}: skipIf composed with an existsSync presence probe (use the factory)`);
      }
      if (factoryUse.test(source) && !source.includes("from './fixtures/native-deps-gate.js'")) {
        offenders.push(`${rel}: calls the gate factory without importing it from './fixtures/native-deps-gate.js'`);
      }
    }
    expect(
      offenders,
      'every native-deps gate must go through the shared factory (no private probes, no bare skip ternaries)',
    ).toEqual([]);
    // Positive presence (review PRR-005): the negative scan alone cannot see
    // a suite whose gate was deleted entirely — the migration must still be
    // there. Every file using a gate variable must be a factory consumer, and
    // the consumer set cannot shrink below the migrated census.
    const consumers: string[] = [];
    const gateUsers: string[] = [];
    for (const file of files.sort()) {
      const rel = path.relative(scanRoot, file).split(path.sep).join('/');
      if (rel === policyHome || rel === netHome) continue;
      const stripped = stripCommentsForScan(fs.readFileSync(file, 'utf8'));
      if (/\bnativeDeps(?:It|DescribeGroup|Decision|Present)\s*\(/.test(stripped)) consumers.push(rel);
      if (/\b(?:itReal|itWithDeps|describeReal)\b/.test(stripped)) gateUsers.push(rel);
    }
    expect(
      consumers.length,
      `the factory consumer set shrank (${consumers.length}); every migrated suite must keep gating`,
    ).toBeGreaterThanOrEqual(34);
    for (const rel of gateUsers) {
      if (ternaryExempt.has(rel)) continue; // documented exemption (its own gate)
      expect(consumers, `${rel} uses a gate variable but no longer calls the factory`).toContain(rel);
    }
    for (const must of ['i169-stats-route-real-seed.test.ts', 'i103b-degrade-contract-sweep.test.ts', 'b5-store.test.ts']) {
      expect(consumers, `${must} must keep gating through the factory`).toContain(must);
    }
    // The one documented ternary exemption must still be the only one — and
    // must still describe reality: the exempt file must carry the gate it is
    // exempt for, and exactly one bare skip gate (a second private gate in
    // that file would otherwise ride the exemption).
    const exemptFiles = [...ternaryExempt.keys()];
    expect(exemptFiles).toEqual(['b4-llama-engine.test.ts']);
    for (const [rel, reason] of ternaryExempt) {
      const raw = fs.readFileSync(path.join(scanRoot, rel), 'utf8');
      expect(raw, `${rel}: exemption reason no longer matches the file`).toContain('REAL_FAST_MODEL');
      const strippedExempt = stripCommentsForScan(raw);
      const gates = strippedExempt.match(/\b(?:it|describe)(?:\.skip)?\s*:\s*(?:it|describe)\.skip\b|\b(?:it|describe)\.skip\s*:\s*(?:it|describe)\b/g) ?? [];
      expect(gates.length, `${rel}: the exemption covers ONE named gate, found ${gates.length}`).toBe(1);
      expect(reason.length, `${rel}: exemption must carry a reason`).toBeGreaterThan(10);
    }
  });
});
