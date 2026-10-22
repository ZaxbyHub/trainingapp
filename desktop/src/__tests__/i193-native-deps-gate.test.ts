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
import Module from 'node:module';
import os from 'node:os';

type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
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

/**
 * Run a nested vitest command with issue #210 (PRR-016/052) hygiene: an
 * EXPLICIT hard timeout on spawnSync AND, when the child was killed by that
 * timeout (status === null), a full process-TREE kill (taskkill /T /F on
 * Windows - with shell:true the wrapper's npm/vitest descendants would
 * otherwise survive the parent kill and hold sqlite handles / ports).
 */
interface NestedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}
function runNestedVitest(
  command: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): NestedRun {
  const result = spawnSync(command, {
    shell: true,
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.status === null && typeof result.pid === 'number' && process.platform === 'win32') {
    spawnSync(`taskkill /T /F /PID ${result.pid}`, { shell: true, encoding: 'utf8' });
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

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
    const result = runNestedVitest(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      env,
      180_000,
    );
    const out = `${result.stdout}\n${result.stderr}`;
    expect(out, out).toContain(NATIVE_DEPS_SKIP_MARKER);
    expect(out, out).toContain(STAGING_INSTRUCTION);
    expect(result.status, out).toBe(0);
    // The non-native AC15 row keeps running on a deps-less box.
    expect(out, out).toMatch(/[1-9][0-9]* passed/);
    expect(out, out).toMatch(/out-of-scope-fields/);
  }, 200_000);

  it('wiring: forced-absent under CI FAILS loudly with the staging instruction', () => {
    // Named mutant: delete the fail-branch throw in i169's suite-scoped
    // beforeAll — the nested run then degrades to row failures without the
    // instruction, so this row must go red.
    const env = {
      ...process.env,
      TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1',
      CI: '1',
    };
    const result = runNestedVitest(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      env,
      180_000,
    );
    const out = `${result.stdout}\n${result.stderr}`;
    // Exclude the null status (review PRR-006): spawnSync reports
    // status: null on timeout or signal death, which would satisfy a bare
    // not.toBe(0) — a killed run must never read as the loud failure.
    expect(result.status, out).not.toBeNull();
    expect(result.status, out).not.toBe(0);
    expect(out, out).toContain('native deps missing under CI');
    expect(out, out).toContain('fail, never silently skip');
    expect(out, out).toContain(STAGING_INSTRUCTION);
  }, 200_000);
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


// ---------------------------------------------------------------------------
// issue #210 AC3 (trace 201-207-208-209-210): the six hygiene residuals, one
// home row each so the batch is falsifiable as a whole (frozen token:
// 'hygiene' - the C13 driver replays exactly these 6 rows). Source-pin rows
// read the pinned files directly (i103b/i211 established pattern); the
// spawn row pins THIS file's runNestedVitest; the store row is BEHAVIORAL.
// ---------------------------------------------------------------------------
function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('native-deps batch hygiene residuals (issue #210 AC3)', () => {
  it('hygiene: enteredGate-bound - i169-llama never awaits an unbounded gate', () => {
    // Named mutant: restore the bare `await enteredGate;` in the mixed-state
    // row - this row goes red.
    const src = readRepoFile('desktop/src/__tests__/i169-llama-getstats-counts.test.ts');
    expect(src).toContain('awaitEntered(enteredGate)');
    expect(src).not.toMatch(/^\s*await enteredGate;/m);
  });

  it('hygiene: afterAll-wiring - drainTempDirs is registered, not only self-drained by its row', () => {
    // Named mutant: delete the afterAll(drainTempDirs) registration - the
    // self-draining tmp-cleanup row keeps passing while litter returns, so
    // only THIS pin sees the wiring.
    const src = readRepoFile('desktop/src/__tests__/i169-llama-getstats-counts.test.ts');
    expect(src).toMatch(/afterAll\(\s*drainTempDirs\s*\)/);
  });

  it('hygiene: restore-source - the i103b recovery row names the concrete backup', () => {
    // Named mutant: revert to the bare toContain(' from ') - a restoredFrom
    // pointing at the WRONG backup file survived it (PRR-049).
    const src = readRepoFile('desktop/src/__tests__/i103b-degrade-contract-sweep.test.ts');
    expect(src).toMatch(/from \$\{backup\.path\}/);
    expect(src).toMatch(/const backup = createBackup\(store, backupsDir\)/);
  });

  it('hygiene: diagnostics-bounded - the timeout dump is capped and hex-redacted', () => {
    // Named mutant: remove the .slice caps / the redaction - an unbounded
    // unredacted buffer returns (PRR-051).
    const src = readRepoFile('desktop/src/__tests__/i103b-degrade-contract-sweep.test.ts');
    expect(src).toMatch(/\.slice\(0, 12\)/);
    expect(src).toMatch(/\.slice\(0, 200\)/);
    expect(src).toMatch(/redacted-hex/);
  });

  it('hygiene: spawn-tree-kill - nested vitest runs are tree-killed with explicit per-test timeouts', () => {
    // Named mutants: drop the taskkill branch from runNestedVitest, or remove
    // the timeoutMs argument / the 200_000 per-test bounds from the wiring
    // rows (PRR-016/052). Pinned from THIS file's source.
    const src = readRepoFile('desktop/src/__tests__/i193-native-deps-gate.test.ts');
    expect(src).toMatch(/function runNestedVitest\(/);
    expect(src).toMatch(/taskkill \/T \/F/);
    expect(src).toMatch(/timeout: timeoutMs/);
    const wiringRows = src.match(/runNestedVitest\(/g) ?? [];
    expect(wiringRows.length, 'both forced-absent wiring rows use the hardened helper').toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/}, 200_000\);/);
  });

  it('hygiene: lazy-load-before-mkdir - a failed native load leaves no created parent dir (behavioral)', async () => {
    // Named mutant: swap sqlite-store back to mkdir-before-load - the parent
    // directory exists after the throw and this row goes red (PRR-043).
    // The r01 Module._load intercept injects the deterministic addon absence
    // on a box that HAS the addons installed (round-1 critic R3a mechanism).
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const mod = Module as unknown as ModuleWithLoad;
    const original = mod._load;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i210-hyg-store-'));
    const dbPath = path.join(root, 'nested', 'store.sqlite');
    try {
      mod._load = (request: string, parent: unknown, isMain: boolean) => {
        if (request === 'better-sqlite3' || request === 'sqlite-vec') {
          const err = new Error(`Cannot find module '${request}'`);
          (err as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return original.call(mod, request, parent, isMain);
      };
      expect(() => openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT })).toThrow(/MODULE_NOT_FOUND|Cannot find module/);
    } finally {
      mod._load = original;
    }
    // The contract: the load failure precedes ANY filesystem mutation - the
    // parent directory was never created.
    expect(fs.existsSync(path.dirname(dbPath)), 'a failed native load must not create the parent dir').toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
