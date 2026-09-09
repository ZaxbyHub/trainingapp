// B4 defect-class guardrail (issue #62, Phase 4.2; unfrozen).
//
// Class: "engine capability wired only at a seam real traffic never reaches"
// plus "engine-specific sampler field names assumed portable across engines".
//
// Absence-form scans (the presence form cannot detect a MISSING marker):
//   1. The node-mode host default MUST resolve its engine through
//      resolveNodeEngine(...) and MUST NOT construct a bare StubEngine
//      default — enumerate the requirement-bearing site (backend/index.ts)
//      and check the co-occurring markers per site.
//   2. wllama's sampler field names (penalty_repeat / penalty_freq /
//      penalty_present / penalty_last_n) may appear ONLY inside
//      inference/penalties.ts (as the documented parity reference) —
//      anywhere else in desktop/main is a portability leak.
// The scanner itself ships with a positive control (a synthetic violation
// built by string concatenation so this file's own source never matches) and
// only ever reads desktop/main/**, never test files (anti-self-match).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../main');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function scanFor(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

// Positive control: a synthetic violation built from fragments so this test
// file's own source can never trip the real scan (which reads main/ only).
const SYNTHETIC_VIOLATION = ['new ', 'StubEngine', '()'].join('');
const SYNTHETIC_SAMPLER = ['penalty_', 'repeat'].join('');

describe('b4-default-engine guardrail (Phase 4.2)', () => {
  it('positive control: the scanner detects a synthetic bare-stub default and sampler leak', () => {
    expect(scanFor(SYNTHETIC_VIOLATION, /new\s+StubEngine\s*\(/)).toBe(true);
    expect(scanFor(SYNTHETIC_SAMPLER, /penalty_repeat|penalty_freq|penalty_present|penalty_last_n/)).toBe(true);
    // And a clean file does not match.
    expect(scanFor('const engine = resolveNodeEngine(process.env);', /new\s+StubEngine\s*\(/)).toBe(false);
  });

  it('the node-mode host default resolves the engine through resolveNodeEngine (no bare StubEngine default)', () => {
    const hostFile = path.join(MAIN_DIR, 'backend', 'index.ts');
    const content = fs.readFileSync(hostFile, 'utf8');
    // Requirement-bearing site must carry BOTH markers: the resolver call and
    // no bare stub construction (absence form).
    expect(content).toContain('resolveNodeEngine(');
    expect(scanFor(content, /new\s+StubEngine\s*\(/)).toBe(false);
  });

  it('wllama sampler field names appear ONLY in inference/penalties.ts under desktop/main', () => {
    const samplerPattern = /penalty_repeat|penalty_freq|penalty_present|penalty_last_n/;
    const violations: string[] = [];
    for (const file of listTsFiles(MAIN_DIR)) {
      if (!samplerPattern.test(fs.readFileSync(file, 'utf8'))) continue;
      const normalized = path.relative(MAIN_DIR, file).split(path.sep).join('/');
      if (normalized !== 'backend/inference/penalties.ts') violations.push(normalized);
    }
    expect(violations, `sampler field names leaked into: ${violations.join(', ')}`).toEqual([]);
  });
});
