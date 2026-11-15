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
// This census VALUE-PINS that surface: a NEW child_process call site in shipped
// desktop code (outside the pinned allowlist) fails this spec, forcing the
// author to either register a utilityProcess launcher or justify + update the
// allowlist. Mutant: adding a bare fork() call site must fail; deleting an
// allowlist entry must fail.
//
// Review finding unclassified-risk-002 (swarm-pr-review run
// pr-review-pr352-20261115, critic-UPHELD with stronger evidence; Stage-B
// reviewer NEEDS_REVISION): the FIRST rewrite matched only literal,
// case-sensitive call shapes, so it could not see a bare `fork(modulePath)`
// (the LIVE gpu-probe.ts launcher), any aliased import (`nodeSpawn(`,
// `nodeFork(`), or `utilityProcess.fork(` — and it pinned allowlist files at
// tokens:0 while they carried live call sites, so its own header claim was
// false. The SECOND rewrite counted "identifiers ending in fork/spawn", which
// the Stage-B reviewer showed is still alias-blind: `spawn as launch` would not
// increase the count. This version keys the census on (1) WHO value-imports
// child_process, (2) the IMPORTED BINDINGS of each allowlisted file with their
// pinned call counts (aliases included, because the local name is what the
// call site uses), and (3) a detector self-test that proves the claimed mutant
// (a planted bare fork() AND a planted aliased spawn) fails.
//
// Known limitation (disclosed): the comment stripper does not parse string
// literals, so a string containing "fork(" would count as a call. No shipped
// file carries one today (that is what the walk row proves).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', 'main');

/**
 * Every shipped file allowed to reach child_process, with the bindings its
 * value import brings in and the pinned call count for each. `bindings` is
 * empty for files whose child surface is NOT child_process (index.ts uses
 * Electron's utilityProcess, pinned separately below). Counts are the real
 * ones measured at the review head; drift in either direction fails.
 */
const ALLOWLIST: Array<{ file: string; bindings: Record<string, number>; namespaces: Record<string, number>; why: string }> = [
  {
    file: 'index.ts',
    bindings: {},
    namespaces: {},
    why: 'the registered Electron utilityProcess launchers (GPU probe, workbook parser, pack extractor, document parser) — not child_process; its utilityProcess.fork count is pinned separately',
  },
  {
    file: 'backend/inference/gpu-probe.ts',
    bindings: { fork: 1 },
    namespaces: {},
    why: 'nodeForkGpuProbe — the plain-node launcher; resolveGpuProbeForkFn refuses inside Electron',
  },
  {
    file: 'backend/ingest/doc-worker.ts',
    bindings: { nodeFork: 1, nodeSpawn: 1 },
    namespaces: {},
    why: 'resolveDocWorkerForkFn refusal pattern: nodeSpawn(process.execPath) source-tree leg + nodeFork, both unreachable inside Electron',
  },
  {
    file: 'backend/ingest/xlsx-worker.ts',
    bindings: { nodeFork: 1, nodeSpawn: 1 },
    namespaces: {},
    why: 'resolveXlsxWorkerForkFn refusal pattern (same shape)',
  },
  {
    file: 'backend/packs/pack-worker.ts',
    bindings: { nodeFork: 1, nodeSpawn: 1 },
    namespaces: {},
    why: 'resolvePackWorkerForkFn refusal pattern (same shape)',
  },
  {
    file: 'backend/sidecar-manager.ts',
    bindings: { nodeSpawn: 1 },
    namespaces: {},
    why: 'injectable nodeSpawn for the sidecar binary — spawns an external command, never process.execPath',
  },
];

/** The registered utilityProcess launchers in index.ts (Electron's API, not
 *  child_process) — pinned so a new unregistered launcher fails. */
const UTILITY_FORK_PINS: Array<{ file: string; calls: number }> = [
  { file: 'index.ts', calls: 4 },
];

/**
 * Case-insensitive callee detector for the WALK: any identifier ENDING in
 * fork/spawn, so a bare `fork(`, `utilityProcess.fork(`, `nodeFork(`,
 * `nodeSpawn(` and `childProcess.spawn(` all count. The leading \w* MUST allow
 * zero characters or a bare `fork(` cannot match — the exact false-negative
 * class the original regex (`[A-Za-z_$][\w$]*(?:fork|spawn)`) had.
 */
const SPAWN_CALL_RE = /\b\w*(?:fork|spawn)\s*\(/gi;

function stripComments(src: string): string {
  // CRLF first: on a Windows checkout every line ends with `\r`, and `$` (or a
  // bare end-of-line assumption) cannot match before it, so a line-comment
  // strip silently no-ops and prose mentions count as call sites.
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*/, ''))
    .join('\n');
}

function countSpawnCalls(src: string): number {
  return (stripComments(src).match(SPAWN_CALL_RE) ?? []).length;
}

/** A value (non-type) import of child_process, in ANY form the language allows:
 *  a named import (`import { fork as nodeFork }`), a namespace import
 *  (`import * as cp`), a default import (`import cp from ...`), a require
 *  (`const cp = require(...)`), or a destructured require
 *  (`const { spawn: launch } = require(...)`). Type-only imports are erased and
 *  bind nothing. The earlier rewrites matched only some of these, so
 *  `const { spawn: launch } = require(...)` and `import cp from ...` escaped
 *  detection (Stage-B reviewer, rounds 2 and 3). */
function childProcessImports(src: string): { named: string[]; namespaces: string[] } {
  const stripped = stripComments(src);
  const named: string[] = [];
  const namespaces: string[] = [];
  const pushBindings = (list: string): void => {
    for (const part of list.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Two alias spellings: `X as Y` (import) and `X: Y` (destructuring).
      const as = part.match(/^(\w+)\s+as\s+(\w+)$/);
      const colon = part.match(/^(\w+)\s*:\s*(\w+)$/);
      named.push(as !== null ? as[2] : colon !== null ? colon[2] : part);
    }
  };
  for (const m of stripped.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    pushBindings(m[1]);
  }
  for (const m of stripped.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
    pushBindings(m[1]);
  }
  for (const m of stripped.matchAll(/import\s*\*\s*as\s*(\w+)\s*from\s*['"](?:node:)?child_process['"]/g)) {
    namespaces.push(m[1]);
  }
  for (const m of stripped.matchAll(/import\s+(\w+)\s+from\s*['"](?:node:)?child_process['"]/g)) {
    namespaces.push(m[1]);
  }
  for (const m of stripped.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
    namespaces.push(m[1]);
  }
  return { named, namespaces };
}

/** The LOCAL names a value import of child_process brings in (`X as Y` -> Y). */
function importedBindings(src: string): string[] {
  return childProcessImports(src).named;
}

function importsChildProcess(src: string): boolean {
  const imports = childProcessImports(src);
  return imports.named.length > 0 || imports.namespaces.length > 0;
}

/** Pinned call count for one imported binding (calls to exactly that name). */
function countBindingCalls(src: string, binding: string): number {
  const re = new RegExp(`\\b${binding}\\s*\\(`, 'g');
  return (stripComments(src).match(re) ?? []).length;
}

/** Pinned call count for one namespace binding (`cp.fork(` / `cp.spawn(`). */
function countNamespaceCalls(src: string, namespace: string): number {
  const re = new RegExp(`\\b${namespace}\\.(?:fork|spawn)\\s*\\(`, 'gi');
  return (stripComments(src).match(re) ?? []).length;
}

describe('#350 class A guardrail: the shipped execPath-spawn surface stays closed', () => {
  test('the detector itself counts every call shape it claims to pin (the header mutant)', () => {
    // The header claims "adding a bare fork() call site must fail" — this row
    // executes that claim against the detector directly, so a future regex
    // narrowing cannot silently restore the original blind spot.
    const counted = [
      'fork(modulePath, args, {});',
      'utilityProcess.fork(modulePath, args, {});',
      'nodeFork(modulePath, args, {});',
      'nodeSpawn(process.execPath, [m]);',
      'childProcess.spawn(process.execPath, [m]);',
      'spawn(process.execPath, [m]);',
      'cp.fork(m);',
    ];
    for (const src of counted) {
      expect(countSpawnCalls(src), `must count: ${src}`).toBe(1);
    }
    const ignored = [
      'forked(x);',
      'resolveGpuProbeForkFn(x);',
      'setTimeout(x, 1);',
      '// fork(modulePath);',
      '/* fork(modulePath); */',
      'const forkCount = 1;',
    ];
    for (const src of ignored) {
      expect(countSpawnCalls(src), `must ignore: ${src}`).toBe(0);
    }
    // CRLF: a line comment must still be stripped when the line ends with \r.
    expect(countSpawnCalls('// fork(modulePath);\r\nfork(modulePath);\r\n')).toBe(1);
  });

  test('an ALIASED child_process import is pinned by its local binding name (Stage-B reviewer finding)', () => {
    // `spawn as launch` does not end in fork/spawn, so a suffix-shaped count
    // would miss every call through it. The binding pin must not.
    const src = "import { spawn as launch } from 'node:child_process';\nlaunch(process.execPath, [m]);";
    expect(importedBindings(src)).toEqual(['launch']);
    expect(countBindingCalls(src, 'launch')).toBe(1);
    // A call to a name the import does NOT bind is not a pinned call.
    const other = "import { spawn as launch } from 'node:child_process';\nspawn(process.execPath, [m]);";
    expect(countBindingCalls(other, 'launch')).toBe(0);
    // ...but the broader walk still sees it (defence in depth).
    expect(countSpawnCalls(other)).toBe(1);
    // Type-only imports are erased and bind nothing.
    expect(importedBindings("import type { ChildProcess } from 'node:child_process';")).toEqual([]);
  });

  test('NAMESPACE, REQUIRE, DEFAULT and DESTRUCTURED-REQUIRE forms are all detected (Stage-B reviewer rounds 2-3)', () => {
    // The round-1 finding was that a suffix-shaped count is alias-blind. The
    // round-2 finding was that only the FIRST named import was recognised, so
    // `import * as cp ... cp.launch()` and a second separately-aliased import
    // escaped both the importer gate and the walk's suffix net.
    const namespaceSrc = "import * as cp from 'node:child_process';\ncp.fork(m);\ncp.spawn(process.execPath, [m]);";
    expect(childProcessImports(namespaceSrc)).toEqual({ named: [], namespaces: ['cp'] });
    expect(countNamespaceCalls(namespaceSrc, 'cp')).toBe(2);
    expect(importsChildProcess(namespaceSrc)).toBe(true);
    // The walk sees cp.fork( through its `fork(` suffix as well.
    expect(countSpawnCalls(namespaceSrc)).toBe(2);

    const requireSrc = "const cp = require('node:child_process');\ncp.fork(m);";
    expect(childProcessImports(requireSrc)).toEqual({ named: [], namespaces: ['cp'] });
    expect(countNamespaceCalls(requireSrc, 'cp')).toBe(1);
    expect(importsChildProcess(requireSrc)).toBe(true);

    // A SECOND, separately-aliased named import in the same file.
    const multiSrc = "import { fork } from 'node:child_process';\nimport { spawn as launch } from 'node:child_process';\nfork(m);\nlaunch(process.execPath, [m]);";
    expect(childProcessImports(multiSrc)).toEqual({ named: ['fork', 'launch'], namespaces: [] });
    expect(countBindingCalls(multiSrc, 'fork')).toBe(1);
    expect(countBindingCalls(multiSrc, 'launch')).toBe(1);

    // Mixed named + namespace + require in one file.
    const mixedSrc = "import { fork as f } from 'node:child_process';\nimport * as cp from 'node:child_process';\nconst r = require('node:child_process');\nf(m); cp.spawn(m); r.fork(m);";
    expect(childProcessImports(mixedSrc)).toEqual({ named: ['f'], namespaces: ['cp', 'r'] });

    // A namespace alias that does NOT end in fork/spawn still counts (the
    // suffix walk would miss `cp.launch(`; the namespace pin does not).
    const aliasedNsSrc = "import * as launcher from 'node:child_process';\nlauncher.fork(m);";
    expect(countNamespaceCalls(aliasedNsSrc, 'launcher')).toBe(1);
    expect(importsChildProcess(aliasedNsSrc)).toBe(true);

    // Round-3 forms: a destructured require and a default import.
    const destructured = "const { spawn: launch } = require('node:child_process');\nlaunch(process.execPath, [m]);";
    expect(childProcessImports(destructured)).toEqual({ named: ['launch'], namespaces: [] });
    expect(countBindingCalls(destructured, 'launch')).toBe(1);
    expect(importsChildProcess(destructured)).toBe(true);

    const defaultImport = "import cp from 'node:child_process';\ncp.fork(m);";
    expect(childProcessImports(defaultImport)).toEqual({ named: [], namespaces: ['cp'] });
    expect(countNamespaceCalls(defaultImport, 'cp')).toBe(1);
    expect(importsChildProcess(defaultImport)).toBe(true);

    // A type-only import in any form still binds nothing.
    expect(childProcessImports("import type { ChildProcess } from 'node:child_process';")).toEqual({ named: [], namespaces: [] });
    expect(importsChildProcess("import type { ChildProcess } from 'node:child_process';")).toBe(false);
  });

  test('every shipped file that value-imports child_process is on the pinned allowlist', () => {
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const rel = path.relative(mainRoot, full).replace(/\\/g, '/');
        if (importsChildProcess(fs.readFileSync(full, 'utf8'))) importers.push(rel);
      }
    };
    walk(mainRoot);
    expect(
      importers.sort(),
      `a new child_process importer must be justified and pinned on the allowlist with a refusal proof (issue #350 class A); found: ${JSON.stringify(importers.sort())}`,
    ).toEqual(ALLOWLIST.filter((e) => Object.keys(e.bindings).length > 0 || Object.keys(e.namespaces).length > 0).map((e) => e.file).sort());
  });

  test('the pinned allowlist files still hold their imported bindings and call counts (drift both ways)', () => {
    for (const entry of ALLOWLIST) {
      const file = path.join(mainRoot, entry.file);
      expect(fs.existsSync(file), `allowlist file missing: ${entry.file}`).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      const imports = childProcessImports(src);
      const bindings = imports.named.sort();
      const namespaces = imports.namespaces.sort();
      expect(
        bindings,
        `${entry.file} child_process named bindings drifted (pinned ${JSON.stringify(Object.keys(entry.bindings).sort())}, found ${JSON.stringify(bindings)}) — pinned rationale: ${entry.why}`,
      ).toEqual(Object.keys(entry.bindings).sort());
      expect(
        namespaces,
        `${entry.file} child_process namespace bindings drifted (pinned ${JSON.stringify(Object.keys(entry.namespaces).sort())}, found ${JSON.stringify(namespaces)}) — pinned rationale: ${entry.why}`,
      ).toEqual(Object.keys(entry.namespaces).sort());
      for (const [binding, pinned] of Object.entries(entry.bindings)) {
        const calls = countBindingCalls(src, binding);
        expect(
          calls,
          `${entry.file} call count for the imported binding '${binding}' drifted (pinned ${pinned}, found ${calls}) — a new site needs a registered utilityProcess launcher or an explicit allowlist update with a refusal proof (issue #350 class A)`,
        ).toBe(pinned);
      }
      for (const [namespace, pinned] of Object.entries(entry.namespaces)) {
        const calls = countNamespaceCalls(src, namespace);
        expect(
          calls,
          `${entry.file} call count for the namespace binding '${namespace}' drifted (pinned ${pinned}, found ${calls}) — issue #350 class A`,
        ).toBe(pinned);
      }
    }
  });

  test('the registered utilityProcess launchers in index.ts stay pinned (drift both ways)', () => {
    for (const pin of UTILITY_FORK_PINS) {
      const src = fs.readFileSync(path.join(mainRoot, pin.file), 'utf8');
      const calls = (stripComments(src).match(/\butilityProcess\.fork\s*\(/g) ?? []).length;
      expect(
        calls,
        `${pin.file} utilityProcess.fork call count drifted (pinned ${pin.calls}, found ${calls}) — a new launcher must be registered through the same seam`,
      ).toBe(pin.calls);
    }
  });

  test('no fork/spawn-shaped call site appears in a shipped file outside the allowlist', () => {
    // Walk every .ts under main/ except tests; a counted CALL (not a comment
    // mention — comments are stripped) in a non-allowlisted file fails.
    const violations: Array<{ file: string; calls: number }> = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const rel = path.relative(mainRoot, full).replace(/\\/g, '/');
        if (ALLOWLIST.some((entry) => entry.file === rel)) continue;
        const calls = countSpawnCalls(fs.readFileSync(full, 'utf8'));
        if (calls > 0) violations.push({ file: rel, calls });
      }
    };
    walk(mainRoot);
    expect(
      violations,
      `new fork/spawn-shaped call sites must go through a registered utilityProcess launcher or a resolveXxForkFn refusal (issue #350 class A); found: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});
