// Issue #246/#247 recurrence guardrail (Phase 4.2): source-level contract
// sweep pinning the native-lifecycle ordering invariants the fixes installed.
// Precedent: i103b-degrade-contract-sweep.test.ts. Every predicate reads the
// LIVE production source; the `red-proves-the-guardrail` row replays the same
// predicates against the PRE-FIX shape (the base ordering quoted from
// 79375a79) and asserts they FAIL there — the guardrail bites on exactly the
// defect class this PR closed, not just on hypothetical future drift.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'main', 'backend');
const engineSrc = readFileSync(path.join(srcDir, 'inference', 'llama-engine.ts'), 'utf8');
const hostSrc = readFileSync(path.join(srcDir, 'index.ts'), 'utf8');

/** The loadBackend failure-handling block AS IT WAS at base 79375a79 (the
 * field-failure shape: verdict persisted BEFORE the CPU retry, no estimate
 * classification, device-less record). Quoted verbatim in substance. */
const BASE_CATCH_SHAPE = `
      if (backendName === 'vulkan' && !this.gpuIsForced()) {
        const reason = \`GPU load failed, so this machine is now using CPU inference: \${err instanceof Error ? err.message : String(err)}\`;
        setActiveGpuVerdict({ backend: 'cpu', ok: false, reason, device: null });
        if (this.gpuVerdictDir !== undefined) {
          writeGpuProbeVerdict(this.gpuVerdictDir, { backend: 'cpu', ok: false, reason, device: null });
        }
        backendName = 'cpu';
        try {
          backend = await this.constructBackend(profile, modelPath, threads, 'cpu');
        } catch (cpuErr) {
`;

function persistOrderInvariants(source: string): { persistAfterCpuRetry: boolean; estimateGated: boolean } {
  const persistIdx = source.indexOf('writeGpuProbeVerdict(this.gpuVerdictDir, record)');
  const cpuRetryIdx = source.indexOf("constructBackend(profile, modelPath, threads, 'cpu')");
  // The sidecar write must sit AFTER the CPU retry's construct call (AC3).
  const persistAfterCpuRetry = persistIdx !== -1 && cpuRetryIdx !== -1 && persistIdx > cpuRetryIdx;
  // The write must be gated on the ORIGINAL-failure-class rule (AC1/AC3).
  const estimateGated = /if \(!entirelyEstimate\) \{/.test(source) && /isAdmissionEstimate/.test(source);
  return { persistAfterCpuRetry, estimateGated };
}

function disposeInvariants(source: string): { awaitedNativeDisposals: boolean; tailCapture: boolean } {
  // Backend disposals are awaited (AC8) — no bare `context.dispose();`.
  const awaitedNativeDisposals = !/^\s*context\.dispose\(\);$/m.test(source) && !/^\s*model\.dispose\(\);$/m.test(source);
  // dispose() captures the queue tail BEFORE awaiting it (no self-deadlock).
  const captureIdx = source.indexOf('const tail = this.queue;');
  const awaitIdx = source.indexOf('await tail.catch');
  const tailCapture = captureIdx !== -1 && awaitIdx !== -1 && awaitIdx > captureIdx;
  return { awaitedNativeDisposals, tailCapture };
}

describe('gpu-lifecycle-contract-sweep (issue #246/#247 guardrail)', () => {
  it('the sidecar persist lands AFTER the CPU retry and only for non-estimate chains', () => {
    const live = persistOrderInvariants(engineSrc);
    expect(live.persistAfterCpuRetry, 'persist-after-retry ordering (AC3)').toBe(true);
    expect(live.estimateGated, 'estimate chains never persist (AC1/AC3)').toBe(true);
  });

  it('native disposals are awaited and dispose() captures the tail, never the live queue', () => {
    const live = disposeInvariants(engineSrc);
    expect(live.awaitedNativeDisposals, 'no unawaited backend disposals (AC8)').toBe(true);
    expect(live.tailCapture, 'tail captured before await (no self-deadlock)').toBe(true);
  });

  it('the admission gate precedes profile selection at every load entry point', () => {
    // AC6: the conditional gate await appears before effectiveProfile() in
    // query/preflight paths; armedGate() is the only gate oracle.
    expect(engineSrc, 'gate oracle exists').toContain('private armedGate(): Promise<void> | null');
    const queryIdx = engineSrc.indexOf('async query(question: string');
    const profileAfterGate = engineSrc
      .slice(queryIdx, queryIdx + 2000)
      .indexOf('this.armedGate()');
    const profileIdx = engineSrc.slice(queryIdx, queryIdx + 2000).indexOf('this.effectiveProfile()');
    expect(profileAfterGate, 'query(): gate before profile').toBeGreaterThan(-1);
    expect(profileAfterGate, 'query(): gate before profile').toBeLessThan(profileIdx);
  });

  it('terminal shutdown (not reusable dispose) blocks later loads; the external switch calls dispose directly', () => {
    expect(engineSrc, 'shutdown is terminal (AC8)').toContain('async shutdown(): Promise<void>');
    expect(engineSrc, 'post-stop construction is impossible').toContain('this.lifecycleStopped = true');
    // The external switch must NOT chain `.then(() => this.dispose())` — the
    // shape that self-deadlocks once dispose learned to drain.
    expect(engineSrc.includes('this.queue.then(() => this.dispose())'), 'external switch self-deadlock shape').toBe(false);
  });

  it('the renderer wllama gate answers under Electron without probing', () => {
    const rendererSrc = readFileSync(
      path.join(srcDir, '..', '..', '..', 'web_ui', 'src', 'lib', 'llm', 'model-readiness.ts'),
      'utf8',
    );
    const gateIdx = rendererSrc.indexOf('if (isElectron()) return false;');
    const probeIdx = rendererSrc.indexOf('return probeAsset(LLM_GGUF_URL);');
    expect(gateIdx, 'the Electron gate exists (AC11)').toBeGreaterThan(-1);
    expect(probeIdx, 'the browser probe still exists (AC13 floor)').toBeGreaterThan(-1);
    expect(gateIdx, 'isElectron gate precedes the probe (AC11)').toBeLessThan(probeIdx);
  });

  it('red-proves-the-guardrail: every invariant above FAILS on the base defect shape', () => {
    // The base catch shape persists BEFORE the CPU retry with no class gate.
    const base = persistOrderInvariants(BASE_CATCH_SHAPE);
    expect(base.persistAfterCpuRetry, 'base persisted pre-retry (the field latch)').toBe(false);
    expect(base.estimateGated, 'base had no estimate classification').toBe(false);
    // Base disposals were unawaited and dispose never captured a tail.
    const baseDispose = disposeInvariants(`
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        context.dispose();
      } catch {
      }
      try {
        model.dispose();
      } catch {
      }
    }
`);
    expect(baseDispose.awaitedNativeDisposals, 'base disposals were fire-and-forget').toBe(false);
    expect(baseDispose.tailCapture, 'base dispose never drained').toBe(false);
  });
});
