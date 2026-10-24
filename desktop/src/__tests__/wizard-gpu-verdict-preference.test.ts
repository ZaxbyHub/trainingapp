// wizard-gpu-verdict-preference.test.ts — 4.5 implementation-review Finding 3
// (collated issues #246 + #247, trace .agents/issue-traces/collated-246-247).
//
// The first-run wizard's GPU verdict input (desktop/main/index.ts:726) must
// read VALIDATED state in holder-first order:
//
//   const gpuVerdict =
//     activeGpuVerdict() ?? (gpuVerdictGate() !== null ? null : readGpuProbeVerdict(path.dirname(storePath)));
//
// Three branches: (1) the module holder's value wins whenever validation has
// published; (2) holder null + ARMED gate = PENDING (null — the raw sidecar is
// never consumed mid-validation, so an unvalidated record cannot drive the
// RAM-rule recommendation, including on the completion path); (3) holder null
// + no gate = the raw sidecar through the STALE-AWARE reader (a no-device or
// mismatched record reads as never-probed).
//
// Driving the real wizard flow in vitest is impractical: it lives inline in
// desktop/main/index.ts's Electron bootstrap (the e2-first-run-wizard spec
// drives only the pure first-run/* modules), and the expression is not
// exported. The rows therefore pin it two ways, per the guardrail's own style:
//   - a SOURCE-CONTRACT row on desktop/main/index.ts (presence, ordering, and
//     exclusivity — no other raw readGpuProbeVerdict call site anywhere in the
//     file, which covers the completion path too), mutation-checked with the
//     base line as the red-proof fixture (the guardrail's red-proves pattern);
//   - BEHAVIORAL rows on the branch semantics, composed VERBATIM from the
//     REAL gpu-probe primitives on fresh module instances (the wiring itself
//     is what the source row bites; a revert of index.ts:726 to the base raw
//     read fails the source row, not these).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GpuProbeVerdict } from '../../main/backend/inference/gpu-probe.js';

type GpuModule = typeof import('../../main/backend/inference/gpu-probe.js');

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A fresh gpu-probe module instance (virgin holder + virgin gate). */
async function freshGpuModule(): Promise<GpuModule> {
  vi.resetModules();
  return await import('../../main/backend/inference/gpu-probe.js');
}

/**
 * The expression under pin, composed VERBATIM from the real primitives the
 * wizard imports (desktop/main/index.ts:25 imports exactly these three).
 */
function composeWizardVerdict(mod: GpuModule, sidecarDir: string): GpuProbeVerdict | null {
  return mod.activeGpuVerdict() ?? (mod.gpuVerdictGate() !== null ? null : mod.readGpuProbeVerdict(sidecarDir));
}

describe('wizard-gpu-verdict-preference: the holder-first read at desktop/main/index.ts:726', () => {
  const indexTsPath = fileURLToPath(new URL('../../main/index.ts', import.meta.url));

  /** The source contract: holder-first, gate-pending, then the stale-aware read. */
  function matchesHolderFirstContract(source: string): { ok: boolean; why: string } {
    const holderFirst = 'activeGpuVerdict() ??';
    const gateArm = 'gpuVerdictGate() !== null';
    const rawRead = 'readGpuProbeVerdict(path.dirname(storePath))';
    if (!source.includes(holderFirst)) return { ok: false, why: 'missing the holder-first read' };
    if (!source.includes(gateArm)) return { ok: false, why: 'missing the armed-gate PENDING branch' };
    if (!source.includes(rawRead)) return { ok: false, why: 'missing the raw sidecar fallback read' };
    const a = source.indexOf(holderFirst);
    const b = source.indexOf(gateArm);
    const c = source.indexOf(rawRead);
    if (!(a < b && b < c)) return { ok: false, why: 'the three branches are not in holder -> pending -> raw order' };
    // Exclusivity: the ONLY call of the raw reader in the whole bootstrap is
    // the one inside the guarded expression (the import line has no call
    // parens). This also covers the completion path: an unguarded second read
    // anywhere else in the file fails here.
    const rawCalls = source.split('readGpuProbeVerdict(').length - 1;
    if (rawCalls !== 1) return { ok: false, why: `expected exactly 1 raw readGpuProbeVerdict call, found ${rawCalls}` };
    return { ok: true, why: '' };
  }

  it('source contract: the wizard reads holder -> pending -> stale-aware raw, and it is the ONLY raw read in the bootstrap', () => {
    const source = fs.readFileSync(indexTsPath, 'utf8');
    const verdict = matchesHolderFirstContract(source);
    expect(verdict.why, 'the holder-first expression must be present, ordered, and exclusive').toBe('');
    expect(verdict.ok).toBe(true);
  });

  it('mutation red-proof: the base raw read FAILS the same contract (the guardrail can actually bite)', () => {
    // MUTANT: the pre-fix line — a bare raw sidecar read with no holder
    // preference and no pending branch. If the contract matcher accepted
    // this, the source row above could never fail on a revert.
    const mutant = [
      'const gpuVerdict = readGpuProbeVerdict(path.dirname(storePath));',
      // A second shape that must also be rejected: holder preference present
      // but the pending branch dropped (mid-validation sidecar consumption).
      'const gpuVerdict = activeGpuVerdict() ?? readGpuProbeVerdict(path.dirname(storePath));',
    ].join('\n');
    const verdict = matchesHolderFirstContract(mutant);
    expect(verdict.ok, `the base raw read must be REJECTED by the contract (got: ${verdict.why})`).toBe(false);
  });

  it('branch 1: a published holder value WINS — even with an armed gate and a valid sidecar present', async () => {
    const mod = await freshGpuModule();
    const sidecarDir = makeTempDir('wizard-holder-');
    mod.writeGpuProbeVerdict(sidecarDir, { backend: 'vulkan', ok: true, reason: 'sidecar says gpu', device: 'gpu-a' });
    const holderVerdict: GpuProbeVerdict = { backend: 'cpu', ok: false, reason: 'validated this lifecycle: cpu', device: 'gpu-a' };
    mod.setActiveGpuVerdict(holderVerdict);
    mod.armGpuVerdictGate(); // gate still armed: must not matter once the holder has a value
    expect(composeWizardVerdict(mod, sidecarDir)).toEqual(holderVerdict);
  });

  it('branch 2: holder null + ARMED gate = PENDING (null) — a valid sidecar is NOT consumed mid-validation', async () => {
    const mod = await freshGpuModule();
    const sidecarDir = makeTempDir('wizard-pending-');
    mod.writeGpuProbeVerdict(sidecarDir, { backend: 'vulkan', ok: true, reason: 'unvalidated stored verdict', device: 'gpu-a' });
    mod.armGpuVerdictGate(); // validation in flight, holder never published
    expect(mod.activeGpuVerdict()).toBeNull();
    expect(composeWizardVerdict(mod, sidecarDir), 'pending validation must read as NO verdict, never the raw record').toBeNull();
  });

  it('branch 3: holder null + no gate = the stale-aware raw read (no-device record -> never-probed)', async () => {
    const mod = await freshGpuModule();
    const sidecarDir = makeTempDir('wizard-raw-');
    // The gate on this fresh module instance has never been armed.
    expect(mod.gpuVerdictGate()).toBeNull();
    // A no-device record cannot be bound to this machine's adapter: the
    // stale-aware reader treats it as never-probed.
    fs.writeFileSync(
      path.join(sidecarDir, mod.GPU_PROBE_SIDECAR),
      JSON.stringify({ v: 1, backend: 'cpu', ok: false, reason: 'no device recorded', device: null }),
    );
    expect(composeWizardVerdict(mod, sidecarDir)).toBeNull();
    // A device-bearing record IS adopted when no validation is in flight and
    // none has published (the pre-host first-run case).
    mod.writeGpuProbeVerdict(sidecarDir, { backend: 'cpu', ok: false, reason: 'raw sidecar verdict', device: 'gpu-a' });
    expect(composeWizardVerdict(mod, sidecarDir)?.reason).toBe('raw sidecar verdict');
  });
});
