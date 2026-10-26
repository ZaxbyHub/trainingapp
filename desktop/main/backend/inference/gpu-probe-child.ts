// Issue #155: the out-of-process half of the GPU capability probe.
//
// Runs as a child of the backend host (ELECTRON_RUN_AS_NODE=1) so that a Vulkan
// driver fault - which aborts rather than throws - cannot take the app with it.
// The contract with the parent is exactly ONE JSON object on stdout, followed by
// exit 0. Anything else is interpreted by the parent as "no usable GPU", which
// is the safe direction.
//
// It loads the model handed to it on argv (the host passes the FAST profile's
// GGUF): the probe validates the BACKEND, the backend behaves identically for
// both profiles, and loading the 1,674,455,040-byte quality GGUF (lfm2.5-2.6b,
// #156) to answer a question the 730,894,048-byte fast GGUF (lfm2-1.2b-rag)
// answers identically would make first boot needlessly slow. Each LFM profile
// ships exactly one file (model.gguf; no image adapter), so the fast GGUF
// figure IS the profile total.
//
// Issue #246 (AC2): the load is admitted by the REAL allocation for this
// child's 512-token context, not node-llama-cpp's default-context VRAM
// estimate — `ignoreMemorySafetyChecks: true` rides the exported option
// builders below, and the module only self-runs as the process ENTRY so
// tests can import it side-effect-free and drive the same builders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Nlc from 'node-llama-cpp';

const PROMPT = 'Reply with only the word: OK';
/** Small on purpose: this measures whether the device produces coherent output,
 *  not how fast it is. Speed is the bench harness's job, not the probe's. */
const MAX_TOKENS = 12;

/**
 * The `getLlama` options the probe child uses (issue #155 AC12: CUDA excluded —
 * the installer does not ship it; `build: 'never'` turns a missing prebuilt
 * into an immediate NoBinaryFoundError instead of a from-source cmake build).
 * Exported so specs pin exactly what the production call site passes.
 */
export const PROBE_LLAMA_OPTIONS: Nlc.LlamaOptions = {
  gpu: { type: 'auto', exclude: ['cuda'] },
  build: 'never',
};

/** The probe's REAL context: 512 tokens (see module header). */
export const PROBE_CONTEXT_SIZE = 512;

/**
 * Issue #246 (AC2): loadModel options for the probe. The admission estimate
 * inside node-llama-cpp sizes the request against the model's DEFAULT context,
 * which the probe never creates — its real context is the 512-token one below —
 * so the estimate over-asks and a misreported free-VRAM figure can reject a
 * load that trivially fits. `ignoreMemorySafetyChecks: true` lets the real
 * allocation decide (LlamaModel.d.ts:162 documents the option).
 */
export function probeModelLoadOptions(modelPath: string): { modelPath: string; gpuLayers: 'max'; ignoreMemorySafetyChecks: true } {
  return { modelPath, gpuLayers: 'max', ignoreMemorySafetyChecks: true };
}

/**
 * Issue #246 (AC2): createContext options for the probe — the context-size
 * resolver runs its own VRAM estimate, so the bypass rides here too
 * (LlamaContext/types.d.ts:171 documents the option).
 */
export function probeContextOptions(): { threads: number; contextSize: number; ignoreMemorySafetyChecks: true } {
  return { threads: 2, contextSize: PROBE_CONTEXT_SIZE, ignoreMemorySafetyChecks: true };
}

function emit(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report));
}

function fail(reason: string, device: string | null = null): void {
  emit({ ok: false, backend: 'cpu', reason, device });
  process.exit(0);
}

// Issue #251 (AC1): the ADAPTER identity captured ONCE per full probe,
// immediately after `getLlama` succeeds and before any disposal, so every
// post-getLlama CPU failure (wrong backend, model-load failure, generation
// failure) can persist a device-bearing CPU verdict. The capture lives at
// module scope so the main()-rejection handler — which runs outside main()'s
// scope — can carry it too (a NATIVE abort emits no report and stays
// device-less by design). Null means the identity is not resolvable
// in-process (lookup failed, adapter list empty, or the failure happened
// before `getLlama`), which keeps the pre-existing device-less semantics for
// those shapes. Driver-supplied names are sanitized (control chars stripped)
// and length-capped before they touch the sidecar or the API.
let probeAdapterDevice: string | null = null;

async function captureAdapterDevice(llama: Nlc.Llama): Promise<void> {
  try {
    const names = await llama.getGpuDeviceNames();
    probeAdapterDevice =
      Array.isArray(names) && names.length > 0
        ? names.join(', ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || null
        : null;
  } catch {
    // A device name is a nicety; never let the capture fail the probe.
    probeAdapterDevice = null;
  }
}

/** Issue #246 (AC4): the device-only mode's report — no sample by contract;
 * gpu-probe.ts's deviceOnly parser reads only {ok, device, backend}. */
async function runDeviceOnly(llama: Nlc.Llama): Promise<void> {
  let device: string | null = null;
  try {
    const names = await llama.getGpuDeviceNames();
    device = Array.isArray(names) && names.length > 0 ? names.join(', ') : null;
  } catch {
    // A device name is a nicety; never let it fail the query.
    device = null;
  }
  emit({ ok: true, backend: 'vulkan', device });
  await llama.dispose().catch(() => {});
}

async function main(): Promise<void> {
  const deviceOnly = process.argv[2] === '--device-only';
  const modelPath = deviceOnly ? undefined : process.argv[2];
  if (!deviceOnly) {
    if (typeof modelPath !== 'string' || modelPath === '') {
      fail('GPU probe received no model path.');
      return;
    }
    if (!fs.existsSync(modelPath)) {
      fail(`GPU probe: the probe model is not staged at ${modelPath}.`);
      return;
    }
  }

  let llama: Nlc.Llama;
  try {
    const nlc = await import('node-llama-cpp');
    llama = await nlc.getLlama(PROBE_LLAMA_OPTIONS);
  } catch (err) {
    fail(`GPU probe: no usable GPU backend (${err instanceof Error ? err.message : String(err)}).`);
    return;
  }

  // Issue #251 (AC1): capture the adapter identity BEFORE any disposal or
  // failure decision — `getGpuDeviceNames()` throws after dispose
  // (Llama.js _ensureNotDisposed), so this is the only point every
  // post-getLlama failure path can share. Device-only mode skips it: its
  // report carries its own fresh lookup, so no double native enumeration on
  // the boot-blocking query path.
  if (!deviceOnly) {
    await captureAdapterDevice(llama);
  }

  const selected = llama.gpu;
  if (selected !== 'vulkan') {
    await llama.dispose().catch(() => {});
    fail(`GPU probe: this host selected "${String(selected)}" rather than a usable Vulkan device.`, probeAdapterDevice);
    return;
  }

  if (deviceOnly) {
    await runDeviceOnly(llama);
    return;
  }

  let model: Nlc.LlamaModel | undefined;
  let context: Nlc.LlamaContext | undefined;
  try {
    // Explicit gpuLayers (llama.cpp #29277: a wrong free-memory report must not
    // silently decide the offload size). Admission is by real allocation for
    // the 512-token context (issue #246 AC2) — see probeModelLoadOptions.
    model = await llama.loadModel(probeModelLoadOptions(modelPath as string));
    context = await model.createContext(probeContextOptions());
  } catch (err) {
    await context?.dispose().catch(() => {});
    await model?.dispose().catch(() => {});
    await llama.dispose().catch(() => {});
    fail(`GPU probe: the GPU could not load the probe model (${err instanceof Error ? err.message : String(err)}).`, probeAdapterDevice);
    return;
  }

  // The generation leg: EVERY terminal path disposes first and emits/exits
  // LAST (issue #246: `fail()` exits the process, so recording the failure and
  // disposing here — instead of exiting inside the catch — is what keeps the
  // awaited teardown on the generation-failure path too).
  let generationFailure: string | null = null;
  try {
    const { LlamaChatSession } = await import('node-llama-cpp');
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      autoDisposeSequence: false,
    });
    // #156: measure decode tok/s while the probe generation runs, so the
    // verdict can carry real throughput (optional `measured`; CPU failure
    // shapes measure nothing and omit it).
    const startedAt = Date.now();
    let decodedTokens = 0;
    const sample = await session.prompt(PROMPT, {
      maxTokens: MAX_TOKENS,
      temperature: 0,
      // The library batches generated tokens into arrays; accept a scalar too
      // (same calling convention llama-engine.ts accepts).
      onToken: (tokens: unknown) => {
        decodedTokens += Array.isArray(tokens) ? tokens.length : 1;
      },
    });
    const elapsedMs = Date.now() - startedAt;
    const measured =
      decodedTokens > 0 && elapsedMs > 0
        ? Number(((decodedTokens / elapsedMs) * 1000).toFixed(1))
        : null;
    // The ADAPTER identity, not the backend name. `selected` is just the string
    // "vulkan", which is the same on every machine and so cannot distinguish
    // devices or support adapter-change detection. Issue #251 (AC5): this
    // reuses the single capture taken right after `getLlama` — no second,
    // potentially inconsistent lookup.
    const device = probeAdapterDevice;
    emit({
      ok: true,
      backend: 'vulkan',
      device,
      // #156: decode tok/s of this probe generation on the active backend.
      measured,
      // The parent re-judges this itself (probeOutputIsSane) rather than
      // trusting the child's ok flag - see gpu-probe.ts.
      sample: String(sample ?? ''),
    });
  } catch (err) {
    generationFailure = err instanceof Error ? err.message : String(err);
  }
  await context.dispose().catch(() => {});
  await model.dispose().catch(() => {});
  await llama.dispose().catch(() => {});
  if (generationFailure !== null) {
    fail(`GPU probe: the GPU failed to generate (${generationFailure}).`, probeAdapterDevice);
  }
}

// Self-run ONLY as the process entry (issue #246: importing this module from a
// spec must be side-effect-free). argv[1] is this script under
// ELECTRON_RUN_AS_NODE; resolve both sides through real paths so a junctioned
// or differently-cased checkout still matches.
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  void main().catch((err: unknown) => {
    // Issue #251 (AC5): a crash after `getLlama` carries the captured adapter
    // identity; before it, the capture is still null (device-less).
    fail(`GPU probe crashed: ${err instanceof Error ? err.message : String(err)}`, probeAdapterDevice);
  });
}
