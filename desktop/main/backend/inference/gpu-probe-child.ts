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
// both profiles, and loading the 2.6 GB quality GGUF to answer a question the
// 332 MB fast GGUF answers identically would make first boot needlessly slow.
import fs from 'node:fs';
import type * as Nlc from 'node-llama-cpp';

const PROMPT = 'Reply with only the word: OK';
/** Small on purpose: this measures whether the device produces coherent output,
 *  not how fast it is. Speed is the bench harness's job, not the probe's. */
const MAX_TOKENS = 12;

function emit(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report));
}

function fail(reason: string, device: string | null = null): void {
  emit({ ok: false, backend: 'cpu', reason, device });
  process.exit(0);
}

async function main(): Promise<void> {
  const modelPath = process.argv[2];
  if (typeof modelPath !== 'string' || modelPath === '') {
    fail('GPU probe received no model path.');
    return;
  }
  if (!fs.existsSync(modelPath)) {
    fail(`GPU probe: the probe model is not staged at ${modelPath}.`);
    return;
  }

  let llama: Nlc.Llama;
  try {
    const nlc = await import('node-llama-cpp');
    const options: Nlc.LlamaOptions = {
      // CUDA is excluded on purpose (issue #155 AC12): the installer does not
      // ship it, so an NVIDIA host must fall back rather than half-work.
      gpu: { type: 'auto', exclude: ['cuda'] },
      // `build: 'never'` is load-bearing. Under ELECTRON_RUN_AS_NODE this
      // process is plain Node as far as the library is concerned, where its
      // documented default is "auto" - which attempts a FROM-SOURCE build when
      // no prebuilt binary matches. That is a multi-minute failure mode. With
      // "never" a missing binary throws NoBinaryFoundError immediately, which
      // is exactly the signal this probe exists to report.
      build: 'never',
    };
    llama = await nlc.getLlama(options);
  } catch (err) {
    fail(`GPU probe: no usable GPU backend (${err instanceof Error ? err.message : String(err)}).`);
    return;
  }

  const selected = llama.gpu;
  if (selected !== 'vulkan') {
    await llama.dispose().catch(() => {});
    fail(`GPU probe: this host selected "${String(selected)}" rather than a usable Vulkan device.`);
    return;
  }

  let model: Nlc.LlamaModel | undefined;
  let context: Nlc.LlamaContext | undefined;
  try {
    // Explicit gpuLayers (llama.cpp #29277: a wrong free-memory report must not
    // silently decide the offload size). 'max' is validated by the probe
    // itself - if it cannot fit, the load throws and the parent reports CPU.
    model = await llama.loadModel({ modelPath, gpuLayers: 'max' });
    context = await model.createContext({ threads: 2, contextSize: 512 });
  } catch (err) {
    await context?.dispose().catch(() => {});
    await model?.dispose().catch(() => {});
    await llama.dispose().catch(() => {});
    fail(`GPU probe: the GPU could not load the probe model (${err instanceof Error ? err.message : String(err)}).`);
    return;
  }

  try {
    const { LlamaChatSession } = await import('node-llama-cpp');
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      autoDisposeSequence: false,
    });
    const sample = await session.prompt(PROMPT, { maxTokens: MAX_TOKENS, temperature: 0 });
    emit({
      ok: true,
      backend: 'vulkan',
      device: selected,
      // The parent re-judges this itself (probeOutputIsSane) rather than
      // trusting the child's ok flag - see gpu-probe.ts.
      sample: String(sample ?? ''),
    });
  } catch (err) {
    fail(`GPU probe: the GPU failed to generate (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    await context.dispose().catch(() => {});
    await model.dispose().catch(() => {});
    await llama.dispose().catch(() => {});
  }
}

void main().catch((err: unknown) => {
  fail(`GPU probe crashed: ${err instanceof Error ? err.message : String(err)}`);
});