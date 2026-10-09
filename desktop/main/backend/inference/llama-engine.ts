// B4 native inference engine (issue #62).
//
// LlamaEngine fills the node backend host's EngineSurface slot with REAL
// llama.cpp inference (previously the B3 StubEngine), replacing the stub as
// the node-mode default. Design contract (approved plan, issue #62 trace):
//   - Quality/Fast profiles auto-selected from free RAM (profile-select.ts);
//   - resident model: one backend per effective profile, loaded lazily on the
//     first query and reused across requests; a profile switch disposes and
//     reconstructs exactly once, deferred until any in-flight generation ends;
//   - cancellation: the EngineSurface CancellationFlag is bridged to the
//     library's abort signal by a 20ms poll (stopOnAbortSignal), so a client
//     disconnect stops emission well inside the 200ms budget;
//   - rag_* settings and the retrieval/document surfaces stay owned by an
//     inner StubEngine (B5/B6/B7 land those); inference.* settings are
//     validated and committed here;
//   - when no model file is staged, queries throw ModelNotConfiguredError,
//     which the server maps to the contract's 503 "engine not initialized"
//     response with a load diagnostic.
//
// The library (node-llama-cpp, npm-shipped prebuilt llama.cpp binaries) is
// imported DYNAMICALLY so that merely constructing the engine — or running
// the CI suite without touching real inference — never loads native code.
// Model ids are recorded as assumption A2 pending ADR-0002 (#56).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatHistoryItem, LlamaChatSession } from 'node-llama-cpp';
import { StubEngine, type StubSettingsState } from '../engine.js';
import type { PackManager } from '../store/pack-manager.js';
import { ModelNotConfiguredError } from '../types.js';
import type {
  BatchIngestResult,
  CancellationFlag,
  DocumentSurface,
  EngineQueryOptions,
  EngineQueryResult,
  EngineSurface,
  IngestFileInput,
  IngestResult,
  LearnAssembler,
  ModelStatus,
  RetrievalSurface,
} from '../types.js';
import { buildPenalties, PENALTY_FULL_CONTEXT_TOKENS, type PenaltyOptions } from './penalties.js';
import { activeGpuVerdict, setActiveGpuVerdict, type GpuProbeVerdict } from './gpu-probe.js';
import {
  EXTERNAL_SETTING_KEYS,
  ExternalProviderState,
  isHeaderSafeValue,
  UNSENDABLE_KEY_MESSAGE,
  type ExternalProviderOptions,
  type ExternalProviderSettingsState,
} from './external-provider.js';
import { generateExternal, listExternalModels, originOf } from './external-generator.js';
import { RequestCancelledError } from '../net/guarded-request.js';
import { ExternalProviderError, scrubSecrets } from '../net/provider-error.js';
import { validateEndpointUrl } from '../../security/endpoint-policy.js';
import {
  defaultThreadCount,
  selectProfile,
  type InferenceProfileName,
  type ProfileSetting,
} from './profile-select.js';

/** Quality-profile GGUF, relative to the model dir (assumption A2, per ADR-0002 #56 pending). */
export const QUALITY_MODEL_SUBPATH = 'gemma-4-e2b-it/model.gguf';
/** Fast-profile GGUF, relative to the model dir (assumption A2, per ADR-0002 #56 pending). */
export const FAST_MODEL_SUBPATH = 'lfm2.5-vl-450m/model.gguf';

// The error class itself lives in ../types.js (the EngineSurface contract
// module) so the transport never depends on a concrete engine; re-exported
// here for the established import path.
export { ModelNotConfiguredError };

/** The loaded-model surface LlamaEngine drives; the injectable test seam. */
export interface LlamaEngineBackend {
  generate(
    question: string,
    opts: {
      history?: unknown[];
      streamCallback?: (token: string) => void;
      cancellationEvent?: CancellationFlag;
      /** settings-wiring-honesty: explicit rag_max_tokens (else the profile's). */
      maxTokens?: number;
      /** settings-wiring-honesty: explicit rag_temperature (else the profile's). */
      temperature?: number;
    },
  ): Promise<{ answer: string; cancelled: boolean }>;
  dispose(): Promise<void>;
}

export interface LlamaEngineFactoryOptions {
  modelPath: string;
  threads: number;
  /** issue #155: the RESOLVED compute backend, not the operator's preference. */
  backend: GpuBackendName;
  /** issue #155 (llama.cpp #29277): explicit offload size, never auto-fit. */
  gpuLayers: 'max' | number;
  /** Effective profile the factory call serves (drives generation params). */
  profile: InferenceProfileName;
}

/** issue #155: the two compute backends the desktop backend can run. CUDA is
 *  deliberately absent - the installer does not ship it, so an NVIDIA host
 *  falls back to Vulkan-or-CPU rather than half-working. */
export type GpuBackendName = 'vulkan' | 'cpu';

/** issue #155: 'auto' lets the persisted probe verdict decide; true forces the
 *  GPU even if the probe disagreed; false forces CPU. An ABSENT setting is
 *  'auto', so an unprobed host behaves exactly as it did before this feature. */
export type GpuSelection = 'auto' | boolean;

/** Explicit offload: every layer, or none. 'auto' is NOT used - llama.cpp
 *  #29277 reports a device whose free-memory figure is wrong, and auto-fit
 *  would silently size the offload from it. */
const EXPLICIT_GPU_LAYERS = 'max' as const;

export interface LlamaEngineOptions {
  /** Model root directory. Precedence over userDataPath and the headless default. */
  modelDir?: string;
  /** Electron injects app.getPath('userData'); models live under <userData>/models. */
  userDataPath?: string;
  profile?: ProfileSetting;
  profileThresholdGb?: number;
  threads?: number;
  /**
   * issue #155: 'auto' (default) follows the GPU probe verdict, `true` forces
   * Vulkan even when the probe disagreed, `false` forces CPU. Widened from the
   * old bare boolean, which could not express "let the app decide".
   */
  vulkan?: GpuSelection;
  /**
   * issue #155: the probe verdict oracle. A SYNC seam, matching the other
   * injection points (freeMemBytes/cpuCount/llamaFactory): the host runs the
   * out-of-process probe at start and hands the engine a reader. Returning null
   * means "never probed", which resolves to CPU.
   */
  gpuVerdict?: () => GpuProbeVerdict | null;
  /**
   * issue #155: called when an automatic ('auto') GPU load fails, so the host
   * can downgrade its in-memory verdict and rewrite the sidecar instead of
   * re-attempting a failing GPU on every subsequent request.
   */
  onGpuLoadFailure?: (verdict: GpuProbeVerdict) => void;
  /** Explicit absolute model file overrides, keyed by profile. */
  models?: { quality?: string; fast?: string };
  /** Injectable seams for tests. */
  freeMemBytes?: () => number;
  cpuCount?: () => number;
  llamaFactory?: (opts: LlamaEngineFactoryOptions) => Promise<LlamaEngineBackend>;
  /**
   * universal-provider-settings-overhaul: external model endpoint wiring —
   * the main-process SecretStore for the API key, the DNS lookup seam for the
   * guarded outbound client, and the airgap flag (TRAININGAPP_AIRGAP=1 read at
   * call time can only tighten it).
   */
  externalProvider?: ExternalProviderOptions;
}

/** Generation params per profile, mirroring the browser RAG presets
 *  (web_ui/src/lib/rag/rag-presets.ts:16-28: quality/fast rows). */
const GIB = 1024 ** 3;
/** #133: quality->fast auto-downgrade margin below the threshold (GiB). */
const AUTO_PROFILE_HYSTERESIS_GB = 2;

const PROFILE_GENERATION: Record<InferenceProfileName, { maxTokens: number; temperature: number }> = {
  quality: { maxTokens: 1024, temperature: 0.2 },
  fast: { maxTokens: 384, temperature: 0.3 },
};
const SAMPLER_TOP_P = 0.9;
const SAMPLER_REPEAT_PENALTY = 1.1;
export const CONTEXT_SIZE = 8192; // DEFAULT_N_CTX parity (web_ui/src/lib/llm/wllama-service.ts:39)
// Exported for the E2 first-run wizard's RAM gate (first-run/ram-gate.ts), which must
// estimate with the SAME context size the engine will actually create — one source of truth.
const CANCEL_POLL_MS = 20;
// Bounds shared by the PUT /settings gate and the env-var ingress so neither
// path can reach createContext() with an unvalidated thread count.
export const INFERENCE_THREADS_MIN = 1;
export const INFERENCE_THREADS_MAX = 64;
// Carry at most this many history turns: the browser client caps at 6
// (buildHistorySnapshot), but the contract accepts unbounded arrays and an
// oversized history would overflow CONTEXT_SIZE on the resident model.
const MAX_HISTORY_TURNS = 12;

// Issue #154 AC3: this is the same groundedness rule the external path already
// ships (external-prompts.ts EXTERNAL_SYSTEM_PROMPT). It is duplicated rather
// than imported because that file is drift-locked to a byte-identical browser
// twin by external-prompts.drift.test.ts; folding this prompt into it would add
// a second property to maintain under that lock for no benefit.
const SYSTEM_PROMPT =
  "You are TrainingApp's local assistant. Answer the user's question directly and concisely. " +
  'When retrieved context is provided, answer only from that context and say when it does not contain the answer.';

// Issue #154 investigated bounding the repeat-penalty lookback, on the premise
// that node-llama-cpp applies it to prompt+generated tokens and was therefore
// discounting the retrieved evidence the model was asked to quote. That premise
// is FALSE. In 3.20.0, LlamaChat.res (LlamaChat.js:811) is written only by
// pushAll(this.res, this.pendingTokens) (:2283) from popFreeChunkTokens() -
// model-generated tokens. The prompt path, injectTokens (:1348-1356), routes
// into prefixTriggerTokens and never into res, and getPenaltyTokens (:1077)
// slices only that generated array. The penalty has therefore never covered
// prompt or retrieved text, and a smaller window cannot protect it. Narrowing
// lastTokens would only shrink anti-repetition coverage of the model's OWN
// output: the base window of 8192 exceeds both shipped generation caps
// (1024/384), so it penalised every generated token. The change is reverted.
//
// Protecting retrieved evidence from repetition penalty would need a mechanism
// this API does not have: the sampler channel carries only punishTokens
// (LlamaChat.js:1971-1976), so there is no way to include or exclude prompt
// tokens. punishTokensFilter and penalizeNewLine operate on that same
// generated-only array.

/** Map contract history turns ({role, content}) to library chat history. */
export function historyToChatHistory(history?: unknown[]): ChatHistoryItem[] {
  if (!Array.isArray(history)) return [];
  const items: ChatHistoryItem[] = [];
  for (const turn of history) {
    if (typeof turn !== 'object' || turn === null) continue;
    const role = (turn as { role?: unknown }).role;
    const content = (turn as { content?: unknown }).content;
    if (typeof content !== 'string') continue;
    if (role === 'user') items.push({ type: 'user', text: content });
    else if (role === 'assistant') items.push({ type: 'model', response: [content] });
  }
  return items.slice(-MAX_HISTORY_TURNS);
}

/** The profile's generation defaults (what GET /settings reports when not explicitly set). */
export function profileGeneration(profile: InferenceProfileName): { maxTokens: number; temperature: number } {
  return PROFILE_GENERATION[profile];
}

/**
 * Prompt sampler options for a profile (PRR-011): the single place the
 * PROFILE_GENERATION/topP/penalties mapping is derived, exported so tests can
 * pin the shape that reaches session.prompt(). settings-wiring-honesty: an
 * explicitly set rag_max_tokens/rag_temperature (overrides) wins over the
 * profile value; an omitted override keeps the profile default.
 */
export function buildGenerationParams(
  profile: InferenceProfileName,
  penalties: object = {},
  overrides: { maxTokens?: number; temperature?: number } = {},
): Record<string, unknown> {
  const generation = PROFILE_GENERATION[profile];
  return {
    maxTokens: overrides.maxTokens ?? generation.maxTokens,
    temperature: overrides.temperature ?? generation.temperature,
    topP: SAMPLER_TOP_P,
    ...(Object.keys(penalties).length > 0 ? { repeatPenalty: penalties } : {}),
  };
}

/**
 * Issue #154: resolve the chat wrapper to pin from the LOADED MODEL's identity,
 * not from the profile name.
 *
 * The shipped quality model is gemma-4, whose auto-resolved Gemma4ChatWrapper
 * defaults reasoning=true - so every answer spent maxTokens budget on thought
 * segments that never reach responseText. Pinning reasoning off fixes that.
 *
 * But a profile is only a label: modelPathFor() honours inference.model /
 * TRAININGAPP_INFERENCE_MODEL_DIR / --model-dir, so a non-Gemma GGUF can sit at
 * the quality path. Forcing Gemma-4 markup onto such a model would be a silent
 * regression (base auto-resolved correctly), so the pin is applied ONLY when the
 * file really is gemma-4. Anything else returns undefined and the library's own
 * "auto" resolution applies, exactly as at base.
 *
 * Returns undefined - meaning "omit the chatWrapper key entirely" - for every
 * non-gemma-4 model, for an unreadable header, and on any inspection error.
 * Omitting is safe: LlamaChatSession defaults the key to "auto" only when it is
 * absent/undefined, and an explicit null would crash on chatWrapper.settings.
 */
async function resolveReasoningSuppressedWrapper(
  nlc: typeof import('node-llama-cpp'),
  modelPath: string,
): Promise<InstanceType<typeof nlc.Gemma4ChatWrapper> | undefined> {
  try {
    const info = await nlc.readGgufFileInfo(modelPath, { sourceType: 'filesystem' });
    const isGemma4 =
      info.metadata?.general?.architecture === 'gemma4' ||
      /gemma[ _-]?4/i.test(String(info.metadata?.general?.name ?? ''));
    if (!isGemma4) return undefined;
    return new nlc.Gemma4ChatWrapper({ reasoning: false });
  } catch {
    // An unreadable header means we cannot prove the model is gemma-4, so we
    // must not pin a wrapper for it. Fall back to the library default.
    return undefined;
  }
}


/** The production backend: node-llama-cpp over one resident loaded model. */
async function defaultLlamaFactory(opts: LlamaEngineFactoryOptions): Promise<LlamaEngineBackend> {
  // Dynamic import: native code loads only when a model is actually needed.
  const nlc = await import('node-llama-cpp');
  // issue #155: the GPU is no longer hard-disabled. The backend was resolved by
  // the probe (or pinned by the operator) BEFORE this call, so this site only
  // has to state the request, not decide it. CUDA is excluded because the
  // installer does not ship it - an NVIDIA host falls back rather than
  // half-working (AC12).
  const llama = await nlc.getLlama(
    opts.backend === 'vulkan' ? { gpu: { type: 'auto', exclude: ['cuda'] } } : { gpu: false },
  );
  // Explicit gpuLayers (llama.cpp #29277: a device whose free-memory figure is
  // wrong must not silently size the offload from it).
  const model = await llama.loadModel({ modelPath: opts.modelPath, gpuLayers: opts.gpuLayers });
  const chatWrapper = await resolveReasoningSuppressedWrapper(nlc, opts.modelPath);
  const context = await model.createContext({ threads: opts.threads, contextSize: CONTEXT_SIZE });
  // ONE resident sequence for the lifetime of the backend: v3 allocates
  // sequences at context creation and `getSequence()` throws once the pool is
  // exhausted — disposed sequences do NOT return to it. Requests stay
  // stateless via resetChatHistory() (see generate), and the engine's
  // per-profile queue guarantees only one generate touches the sequence.
  const sequence = context.getSequence();
  let disposed = false;
  return {
    async generate(question, genOpts) {
      // #154 AC2: exactly one metrics line per request, including the two
      // pre-flight exits below and any throw, so the emission is opened here
      // and closed in a single place rather than only inside the try/finally.
      const startedAt = Date.now();
      let generatedTokens = 0;
      const logMetrics = (outcome: 'ok' | 'cancelled' | 'error'): void => {
        // profile / threads / elapsed_ms / answer_tokens. `answer_tokens`
        // counts only tokens that reach responseText: onToken does not fire for
        // thought segments, and reasoning is disabled for the quality profile.
        console.info(
          `[trainingapp-backend] inference profile=${opts.profile} threads=${opts.threads} ` +
            `elapsed_ms=${Date.now() - startedAt} answer_tokens=${generatedTokens} outcome=${outcome}`,
        );
      };
      if (disposed) {
        logMetrics('error');
        throw new Error('the inference backend has been disposed');
      }
      if (genOpts.cancellationEvent?.isSet()) {
        logMetrics('cancelled');
        return { answer: '', cancelled: true };
      }
      const penalties = buildPenalties({ repeatPenalty: SAMPLER_REPEAT_PENALTY } satisfies PenaltyOptions, PENALTY_FULL_CONTEXT_TOKENS);
      const abort = new AbortController();
      // Cancel bridge: the CancellationFlag polls at 20ms and aborts the
      // library prompt (stopOnAbortSignal) — emission stops far inside 200ms.
      const poll = setInterval(() => {
        if (genOpts.cancellationEvent?.isSet()) abort.abort();
      }, CANCEL_POLL_MS);
      // AC2 exactly-one: the session construction and history seeding are
      // INSIDE the try so a throw on either path still reaches the finally's
      // logMetrics. `session` stays nullable because the finally must not
      // touch it when construction itself failed.
      let session: LlamaChatSession | null = null;
      let outcome: 'ok' | 'cancelled' | 'error' = 'ok';
      try {
        session = new nlc.LlamaChatSession({
          contextSequence: sequence,
          systemPrompt: SYSTEM_PROMPT,
          autoDisposeSequence: false,
        // #154 AC1: pin reasoning off, but only for a model actually
        // verified to be gemma-4. The key is OMITTED (never null/undefined)
        // for every other model so LlamaChatSession applies its own "auto".
        ...(chatWrapper ? { chatWrapper } : {}),
        });
        const seededHistory = historyToChatHistory(genOpts.history);
        if (seededHistory.length > 0) session.setChatHistory(seededHistory);
        const answer = await session.prompt(question, {
          onTextChunk(chunk: string) {
            genOpts.streamCallback?.(chunk);
          },
          // The library delivers batched arrays; accept a scalar too so the
          // count stays a token count under either calling convention.
          onToken(tokens: unknown) {
            generatedTokens += Array.isArray(tokens) ? tokens.length : 1;
          },
          signal: abort.signal,
          stopOnAbortSignal: true,
          ...buildGenerationParams(opts.profile, penalties, {
            maxTokens: genOpts.maxTokens,
            temperature: genOpts.temperature,
          }),
        });
        outcome = genOpts.cancellationEvent?.isSet() ? 'cancelled' : 'ok';
        return { answer, cancelled: genOpts.cancellationEvent?.isSet() ?? false };
      } catch (err) {
        // The library THROWS rather than returning when an abort lands
        // before any token (LlamaChat.js:2245-2247), so a user cancellation
        // during prefill arrives here. Distinguish it from a real failure.
        outcome = genOpts.cancellationEvent?.isSet() ? 'cancelled' : 'error';
        throw err;
      } finally {
        clearInterval(poll);
        // Emit BEFORE resetChatHistory: reset can throw DisposedError, which
        // would otherwise swallow this request's only metrics line.
        logMetrics(outcome);
        // Statelessness: drop the session history so the next request starts
        // clean (the sequence KV is re-evaluated from the fresh history).
        session?.resetChatHistory();
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        context.dispose();
      } catch {
        // best-effort teardown
      }
      try {
        model.dispose();
      } catch {
        // best-effort teardown
      }
    },
  };
}

/**
 * Env ingress for the thread count — the SAME 1..64 gate the PUT /settings
 * path enforces, so an operator env var cannot bypass settings validation
 * (PRR-001: "0", "999999", "0x8", "8.9" all resolve to the default).
 */
export function parseEnvThreads(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return value >= INFERENCE_THREADS_MIN && value <= INFERENCE_THREADS_MAX ? value : undefined;
}

/** Engine selection for the node backend host (B4). */
export function resolveNodeEngine(
  env: Record<string, string | undefined> = process.env,
  overrides?: {
    userDataPath?: string;
    /** E1 (issue #84): packaged per-profile model file overrides, derived by
     *  the startup integrity gate from the VERIFIED installer manifest. */
    models?: { quality?: string; fast?: string };
    /** universal-provider-settings-overhaul: SecretStore + airgap flag. */
    externalProvider?: ExternalProviderOptions;
    /** issue #155: the probe verdict reader the host owns (see LlamaEngineOptions). */
    gpuVerdict?: () => GpuProbeVerdict | null;
    /** issue #155: notified when an automatic GPU load fails. */
    onGpuLoadFailure?: (verdict: GpuProbeVerdict) => void;
  },
): EngineSurface {
  if (env.TRAININGAPP_DESKTOP_ENGINE === 'stub') {
    // Explicit dev/CI fixture: transport/conformance testing without weights.
    return new StubEngine();
  }
  const threads = parseEnvThreads(env.TRAININGAPP_DESKTOP_INFERENCE_THREADS);
  const profileEnv = env.TRAININGAPP_DESKTOP_INFERENCE_PROFILE;
  const profile =
    profileEnv === 'quality' || profileEnv === 'fast' || profileEnv === 'auto'
      ? (profileEnv as ProfileSetting)
      : undefined;
  return new LlamaEngine({
    modelDir: env.TRAININGAPP_INFERENCE_MODEL_DIR,
    userDataPath: overrides?.userDataPath,
    ...(overrides?.models !== undefined ? { models: overrides.models } : {}),
    ...(overrides?.externalProvider !== undefined ? { externalProvider: overrides.externalProvider } : {}),
    ...(overrides?.gpuVerdict !== undefined ? { gpuVerdict: overrides.gpuVerdict } : {}),
    ...(overrides?.onGpuLoadFailure !== undefined ? { onGpuLoadFailure: overrides.onGpuLoadFailure } : {}),
    profile,
    ...(threads !== undefined ? { threads } : {}),
  });
}

interface ResidentEntry {
  backend: LlamaEngineBackend;
  profile: InferenceProfileName;
  inFlight: number;
  /**
   * issue #155: the identity the resident was BUILT with. Before this field
   * existed, reuse keyed on `profile` alone, so a settings change to the backend
   * selection (or to threads) updated the field and was reported back by
   * responseSettings() while the model kept running on the old backend - the
   * switch moved and nothing changed. The effective backend is part of the key.
   */
  backendIdentity: string;
}

/** LlamaEngine.captureSettingsState() snapshot (PR #140 review FB140-001). */
export interface LlamaSettingsState {
  readonly stub: StubSettingsState;
  readonly profileSetting: ProfileSetting;
  readonly thresholdGb: number;
  readonly threadsSetting: number | undefined;
  readonly vulkanSetting: GpuSelection | undefined;
  readonly stickyAuto: InferenceProfileName | null;
  /** PR #142 rebase RB-001: external.* values, the session key and the SecretStore entries. */
  readonly external: ExternalProviderSettingsState;
}

export class LlamaEngine implements EngineSurface {
  /** rag_* settings + retrieval/document surfaces stay stub-owned (B5/B6/B7). */
  private readonly stub = new StubEngine();
  private readonly freeMemBytes: () => number;
  private readonly cpuCount: () => number;
  private readonly llamaFactoryFn: (opts: LlamaEngineFactoryOptions) => Promise<LlamaEngineBackend>;
  private profileSetting: ProfileSetting;
  private thresholdGb: number;
  private vulkanSetting: GpuSelection | undefined;
  private threadsSetting: number | undefined;
  /** issue #155: the probe verdict reader seam (null = never probed). */
  private readonly gpuVerdictFn: () => GpuProbeVerdict | null;
  /** issue #155: notified when an automatic GPU load fails, so the host can
   *  downgrade its in-memory verdict AND rewrite the sidecar. */
  private readonly onGpuLoadFailure: ((verdict: GpuProbeVerdict) => void) | undefined;
  private readonly modelDirOption: string | undefined;
  private readonly userDataPath: string | undefined;
  private readonly modelOverrides: { quality?: string; fast?: string };
  private resident: ResidentEntry | null = null;
  private loads = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * B8 (issue #66) downgrade actuator: when latched ('fast' under sustained
   * memory pressure), it shadows the user's inference.profile setting until
   * the host clears it. The SETTING is never mutated, so the user's choice
   * resumes automatically once the host clears the override (AC3: the only
   * profile upgrade path is explicit host policy between generations).
   */
  private profileOverride: InferenceProfileName | null = null;
  /**
   * #133: sticky resolution of the AUTO profile band. selectProfile() flips
   * at a single 6 GiB boundary; on a loaded machine free RAM oscillates
   * around it per query, and each flip swaps + fully reloads the resident
   * model (the operator saw multi-minute EVERY request). The sticky value
   * only crosses the band when the regime is decisive: fast -> quality at
   * the full threshold, quality -> fast one hysteresis band below it.
   */
  private stickyAuto: InferenceProfileName | null = null;
  /** #133: resident-model load state surfaced to the renderer (chat gating). */
  private loadState: 'idle' | 'loading' | 'ready' = 'idle';
  private loadStartedAt: number | null = null;
  /**
   * The profile a load in flight is loading. `resident` is null from the
   * moment a switch decision disposes the old backend until the new one is
   * ready, so without this the status payload would report profile null for
   * the whole 'loading' window and the chat banner could not say WHICH model
   * is loading (round-5 review finding).
   */
  private loadingProfile: InferenceProfileName | null = null;
  /** Single-flight load: concurrent warmup + first query load ONE backend. */
  private loadInFlight: Promise<ResidentEntry> | null = null;
  /** universal-provider-settings-overhaul: external endpoint state (off by default). */
  private readonly external: ExternalProviderState;

  constructor(options: LlamaEngineOptions = {}) {
    this.freeMemBytes = options.freeMemBytes ?? (() => os.freemem());
    this.cpuCount = options.cpuCount ?? (() => os.cpus().length);
    this.llamaFactoryFn = options.llamaFactory ?? defaultLlamaFactory;
    this.profileSetting = options.profile ?? 'auto';
    this.thresholdGb = options.profileThresholdGb ?? 6;
    this.vulkanSetting = options.vulkan;
    this.threadsSetting = options.threads;
    this.gpuVerdictFn = options.gpuVerdict ?? activeGpuVerdict;
    this.onGpuLoadFailure = options.onGpuLoadFailure;
    this.modelDirOption = options.modelDir;
    this.userDataPath = options.userDataPath;
    this.modelOverrides = options.models ?? {};
    this.external = new ExternalProviderState(options.externalProvider);
  }

  /** Headless-safe model dir: option -> <userData>/models -> ~/.trainingapp/models. */
  private resolveModelDir(): string {
    if (this.modelDirOption !== undefined && this.modelDirOption.length > 0) return this.modelDirOption;
    if (this.userDataPath !== undefined && this.userDataPath.length > 0) {
      return path.join(this.userDataPath, 'models');
    }
    return path.join(os.homedir(), '.trainingapp', 'models');
  }

  /**
   * The effective inference profile for the NEXT query: the B8 pressure
   * override wins when latched, else B4's selectProfile semantics
   * (explicit setting beats auto-by-free-RAM; inclusive 6 GiB boundary).
   * Public so the host (backend/index.ts) can observe it for telemetry.
   */
  effectiveProfile(): InferenceProfileName {
    if (this.profileOverride !== null) return this.profileOverride;
    if (this.profileSetting !== 'auto') return this.profileSetting;
    const free = this.freeMemBytes();
    const hi = this.thresholdGb * GIB;
    const lo = Math.max(0, this.thresholdGb - AUTO_PROFILE_HYSTERESIS_GB) * GIB;
    if (this.stickyAuto === null) {
      this.stickyAuto = free >= hi ? 'quality' : 'fast';
    } else if (this.stickyAuto === 'quality' && free < lo) {
      this.stickyAuto = 'fast';
    } else if (this.stickyAuto === 'fast' && free >= hi) {
      this.stickyAuto = 'quality';
    }
    return this.stickyAuto;
  }

  /** #133: resident-model load state for the renderer's chat gating. */
  residentLoadStatus(): { state: 'idle' | 'loading' | 'ready'; profile: InferenceProfileName | null; loadStartedAt: number | null } {
    return {
      state: this.loadState,
      profile: this.loadState === 'loading' ? this.loadingProfile : (this.resident?.profile ?? null),
      loadStartedAt: this.loadStartedAt,
    };
  }

  /**
   * #133: load the effective-profile model at APP START (background) so the
   * renderer can show "loading, chat disabled" with an honest ETA instead of
   * the old lazy behavior where the first question ate the load. Never
   * throws: a failed warmup leaves state idle and the first /ask retries.
   */
  async warmup(): Promise<void> {
    // An external endpoint generates: no local model is loaded or warmed.
    if (this.external.active()) return;
    try {
      const profile = this.effectiveProfile();
      const modelPath = this.assertModelAvailable(profile);
      await this.ensureResident(profile, modelPath);
    } catch (err) {
      this.loadState = 'idle';
      this.loadStartedAt = null;
      console.error(
        `[trainingapp-backend] model warmup failed (the first /ask will retry the load): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * B8 (issue #66): the host latches 'fast' under sustained memory pressure
   * and clears with null on recovery (between generations only). Passing the
   * same value twice is a no-op; an unknown value is ignored.
   */
  setProfileOverride(profile: InferenceProfileName | null): void {
    if (profile !== null && profile !== 'quality' && profile !== 'fast') return;
    this.profileOverride = profile;
  }

  private effectiveThreads(): number {
    return this.threadsSetting ?? defaultThreadCount(this.cpuCount());
  }

  /**
   * issue #155: resolve the operator's PREFERENCE against the probe verdict
   * into the backend that will actually run.
   *
   *   true  -> force Vulkan, even when the probe disagreed. A forced GPU that
   *            cannot load surfaces the error; it never silently degrades.
   *   false -> force CPU.
   *   auto  -> follow a GPU-ok verdict; otherwise CPU. An ABSENT verdict
   *            (never probed) resolves to CPU, so an unprobed host behaves
   *            exactly as it did before this feature existed.
   */
  private effectiveGpuBackend(): GpuBackendName {
    const selection = this.vulkanSetting ?? 'auto';
    if (selection === false) return 'cpu';
    if (selection === true) return 'vulkan';
    const verdict = this.gpuVerdictFn();
    return verdict !== null && verdict.ok && verdict.backend === 'vulkan' ? 'vulkan' : 'cpu';
  }

  /** issue #155: whether the operator pinned the choice rather than delegating
   *  it. Load-time auto-downgrade is allowed only when they did not. */
  private gpuIsForced(): boolean {
    return this.vulkanSetting === true || this.vulkanSetting === false;
  }

  /** issue #155: the verdict as the API reports it. Absent verdict reads as a
   *  CPU decision with a stated reason rather than an absent field, so the
   *  renderer never has to guess. */
  private gpuStatus(): { backend: GpuBackendName; ok: boolean; reason: string; device: string | null } {
    const verdict = this.gpuVerdictFn();
    if (verdict === null) {
      return {
        backend: 'cpu',
        ok: false,
        reason: 'GPU acceleration has not been tested on this machine yet; CPU inference is in use.',
        device: null,
      };
    }
    return { backend: verdict.backend, ok: verdict.ok, reason: verdict.reason, device: verdict.device ?? null };
  }

  /** The resident reuse key for the NEXT load: everything a backend is built
   *  from that a settings change can alter. Model path included so a profile
   *  file swap reloads too. */
  private backendIdentityFor(profile: InferenceProfileName, modelPath: string): string {
    return this.identityFrom(profile, modelPath, this.effectiveThreads(), this.effectiveGpuBackend());
  }

  /** The key built from an EXPLICIT set of construction values, so a load can
   *  record what it really used rather than what live state says now. */
  private identityFrom(
    profile: InferenceProfileName,
    modelPath: string,
    threads: number,
    backend: GpuBackendName,
  ): string {
    return [profile, modelPath, threads, backend].join('|');
  }

  private modelPathFor(profile: InferenceProfileName): string {
    const override = profile === 'quality' ? this.modelOverrides.quality : this.modelOverrides.fast;
    if (override !== undefined && override.length > 0) return override;
    return path.join(this.resolveModelDir(), profile === 'quality' ? QUALITY_MODEL_SUBPATH : FAST_MODEL_SUBPATH);
  }

  private assertModelAvailable(profile: InferenceProfileName): string {
    const modelPath = this.modelPathFor(profile);
    if (!existsSync(modelPath)) {
      const subpath = profile === 'quality' ? QUALITY_MODEL_SUBPATH : FAST_MODEL_SUBPATH;
      throw new ModelNotConfiguredError(
        `No ${profile} model found at ${modelPath}. Stage the GGUF there, or set TRAININGAPP_INFERENCE_MODEL_DIR ` +
          `(dev-server --model-dir) to the directory containing ${subpath}.`,
      );
    }
    return modelPath;
  }

  /**
   * Readiness check the server runs BEFORE writing any response byte, so a
   * missing model surfaces as the contract's 503 rather than a mid-stream
   * error. Throws ModelNotConfiguredError when the model is unavailable.
   */
  async preflight(): Promise<void> {
    // AC8: an external endpoint needs no local model file.
    if (this.external.active()) return;
    this.assertModelAvailable(this.effectiveProfile());
  }

  /**
   * B9 (issue #67): launch-time per-profile GGUF presence for
   * GET /status/models. Disk presence at the SAME resolved paths
   * assertModelAvailable() enforces — presence here means a later /ask for
   * that profile will not 503 — and never whether a model is resident.
   * NOTE (review PRR-240): this is NOT side-effect-free — the `profile`
   * field comes from effectiveProfile(), which can advance the sticky AUTO
   * hysteresis latch. The band bounds any poll-induced flip to a real
   * threshold crossing, so telemetry cannot cause a reload by itself.
   */
  modelStatus(): ModelStatus {
    const statusFor = (profile: InferenceProfileName) => {
      const modelPath = this.modelPathFor(profile);
      return existsSync(modelPath) ? { present: true, path: modelPath } : { present: false };
    };
    const external = this.external.active();
    return {
      // AC8: 'external' tells the renderer that absent GGUFs never gate chat.
      engine: external ? 'external' : 'llama.cpp',
      profile: this.effectiveProfile(),
      models: { quality: statusFor('quality'), fast: statusFor('fast') },
      resident: external ? { state: 'idle', profile: null, loadStartedAt: null } : this.residentLoadStatus(),
      // issue #155: the detected backend, whether it works, and WHY - so the
      // Settings surface can show a reason instead of a silent CPU. Absent on
      // an external endpoint, where no local backend is involved at all.
      ...(external ? {} : { gpu: this.gpuStatus() }),
    };
  }

  private async ensureResident(profile: InferenceProfileName, modelPath: string): Promise<ResidentEntry> {
    // issue #155: reuse requires the whole backend identity to match, not just
    // the profile - so changing the GPU selection (or threads) actually reloads.
    const identity = this.backendIdentityFor(profile, modelPath);
    if (this.resident !== null && this.resident.backendIdentity === identity) return this.resident;
    if (this.loadInFlight !== null) {
      // Single-flight: a warmup (or a concurrent query) already loading a
      // backend — await it, then re-evaluate (it may even be the identity we
      // want). The in-flight promise never re-enters this branch.
      const loaded = await this.loadInFlight;
      if (loaded.backendIdentity === identity) return loaded;
    }
    const load = this.loadBackend(profile, modelPath);
    this.loadInFlight = load;
    try {
      return await load;
    } finally {
      this.loadInFlight = null;
    }
  }

  private async loadBackend(profile: InferenceProfileName, modelPath: string): Promise<ResidentEntry> {
    const old = this.resident;
    if (old !== null) {
      this.resident = null;
      // A backend switch defers to post-request: the per-engine queue means the
      // caller only reaches this point after prior generations completed, so
      // the old backend is idle and safe to dispose synchronously. Disposing
      // BEFORE constructing the next one is what keeps exactly one context
      // alive (issue #155 change 2).
      await old.backend.dispose().catch(() => {});
    }
    const threads = this.effectiveThreads();
    let backendName = this.effectiveGpuBackend();
    let backend: LlamaEngineBackend;
    this.loadState = 'loading';
    this.loadStartedAt = Date.now();
    this.loadingProfile = profile;
    try {
      backend = await this.constructBackend(profile, modelPath, threads, backendName);
    } catch (err) {
      // issue #155: load-time CPU retry, AUTOMATIC PATH ONLY. The probe
      // validated the DEVICE with the fast model; nothing else proves the
      // quality GGUF fits on it, so a GPU load failure here is real evidence
      // and must not leave the user without an answer. An operator-pinned
      // selection is never retried: "force the GPU" that silently degrades to
      // CPU is not force, so that failure surfaces.
      if (backendName === 'vulkan' && !this.gpuIsForced()) {
        const reason = `GPU load failed, so this machine is now using CPU inference: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[trainingapp-backend] ${reason}`);
        // Publish the downgrade to the SHARED holder the default `gpuVerdict`
        // seam reads. This is what makes it work in production: the engine is
        // constructed by resolveNodeEngine before any host exists, so a
        // host-supplied callback could never be wired there. Writing it here
        // means the very next load in this session resolves to cpu instead of
        // re-attempting a failing GPU on every subsequent request.
        setActiveGpuVerdict({ backend: 'cpu', ok: false, reason, device: null });
        // The optional hook remains for a caller that wants to persist it.
        this.onGpuLoadFailure?.({ backend: 'cpu', ok: false, reason, device: null });
        backendName = 'cpu';
        try {
          backend = await this.constructBackend(profile, modelPath, threads, 'cpu');
        } catch (cpuErr) {
          this.markLoadFailed();
          throw new ModelNotConfiguredError(
            `Failed to load the ${profile} model from ${modelPath}: ${cpuErr instanceof Error ? cpuErr.message : String(cpuErr)}`,
          );
        }
      } else {
        this.markLoadFailed();
        // Corrupt/unloadable model: wrap into the 503-diagnostic error type,
        // carrying the underlying failure for the operator.
        throw new ModelNotConfiguredError(
          `Failed to load the ${profile} model from ${modelPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.loads += 1;
    this.markLoadReady();
    const entry: ResidentEntry = {
      backend,
      profile,
      inFlight: 0,
      // Built from the values this load ACTUALLY used - `backendName` captured
      // before the awaits - not from live state re-read afterwards. A verdict
      // that lands mid-load would otherwise be folded into the key while the
      // resident was built from the old one: the next query would compute the
      // same (post-adoption) key, see a match, and reuse a resident that runs
      // the previous backend forever, while the status reports the new one.
      backendIdentity: this.identityFrom(profile, modelPath, threads, backendName),
    };
    this.resident = entry;
    return entry;
  }

  /** A load that succeeded: report 'ready' with no in-flight window. */
  private markLoadReady(): void {
    this.loadState = 'ready';
    this.loadStartedAt = null;
    this.loadingProfile = null;
  }

  /**
   * A load that failed: report 'idle', NEVER 'ready' and NEVER a stuck
   * 'loading' (the #133 round-4 contract: a failed warmup leaves state idle and
   * the first /ask retries). Called on every throw path.
   */
  private markLoadFailed(): void {
    this.loadState = 'idle';
    this.loadStartedAt = null;
    this.loadingProfile = null;
  }

  /** One construction attempt, wrapped so a failure carries the operator-facing
   *  detail without losing the load-state reset. */
  private async constructBackend(
    profile: InferenceProfileName,
    modelPath: string,
    threads: number,
    backendName: GpuBackendName,
  ): Promise<LlamaEngineBackend> {
    try {
      return await this.llamaFactoryFn({
        modelPath,
        threads,
        backend: backendName,
        gpuLayers: EXPLICIT_GPU_LAYERS,
        profile,
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async query(question: string, opts: EngineQueryOptions = {}): Promise<EngineQueryResult> {
    if (this.external.active()) return this.queryExternal(question, opts);
    const started = Date.now();
    const profile = this.effectiveProfile();
    // PR #140 review (FB140-006): read the generation overrides together with
    // the profile and BEFORE retrieval / the queue wait — the retrieval step
    // reads n_results and the rerank flag synchronously below — so one query
    // uses one settings snapshot even if a PUT /settings lands mid-flight.
    // Still per query, never frozen at model load.
    const overrides = this.stub.generationOverrides();
    const modelPath = this.assertModelAvailable(profile);
    // B7 (issue #65): the retrieval step inside /ask//ask/stream. When the
    // host attached a retrieval surface, the hybrid pipeline runs BEFORE
    // generation: sources/context_length become real and the prompt is
    // grounded by prepending the retrieved chunks to the question string
    // (zero change when no surface is attached). An /ask cancellation during
    // an in-flight retrieval lets the work complete and discards the result —
    // the rerank worker is never terminated mid-query.
    const context = await this.stub.retrieveContext(question, opts.nResults);
    const groundedQuestion =
      context === null
        ? question
        : `${'Answer the question using the retrieved context when relevant.'}\n\n${context.texts
            .map((text, index) => `[${index + 1}] ${text}`)
            .join('\n\n')}\n\n\nQuestion: ${question}`;
    const run = this.queue.then(async () => {
      const entry = await this.ensureResident(profile, modelPath);
      entry.inFlight += 1;
      try {
        // settings-wiring-honesty: explicit rag_max_tokens/rag_temperature
        // (read at query start, above) are passed only when set so the
        // profile defaults apply otherwise.
        const result = await entry.backend.generate(groundedQuestion, {
          history: opts.history,
          streamCallback: opts.streamCallback,
          cancellationEvent: opts.cancellationEvent,
          ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
          ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
        });
        const out: EngineQueryResult = {
          answer: result.answer,
          sources: context?.sources ?? [],
          context_length: context?.contextLength ?? 0,
          inference_time: (Date.now() - started) / 1000,
        };
        if (result.cancelled) out.cancelled = true;
        // C5 (issue #72): grounded/general provenance — non-empty
        // FLOOR-QUALIFIED evidence set on a non-cancelled query. The floor
        // gates scores only on the reranker path (context.floorActive), so a
        // fused-path result resolves "general" instead of claiming a
        // relevance decision the pipeline never made.
        out.grounding =
          !result.cancelled &&
          context !== null &&
          context.cited.length > 0 &&
          context.floorActive
            ? 'grounded'
            : 'general';
        // C4 (issue #71): cited chunks ride the internal result so the
        // server serializes pack-attributed citations (internal only).
        if (context !== null) out.cited = context.cited;
        // D6 (issue #82): learn rows from the attached assembler when real
        // retrieval produced cited chunks (null assembler result → omitted).
        // C5: the grounding value rides along so "general" suppresses to [].
        if (!result.cancelled && context !== null && context.cited.length > 0 && this.learnAssembler !== null) {
          const learn = this.learnAssembler(context.cited, out.grounding);
          if (learn !== null) out.learn = learn;
        }
        return out;
      } finally {
        entry.inFlight -= 1;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * universal-provider-settings-overhaul (AC5/AC6/AC13): generation through
   * the configured external endpoint. Retrieval is the SAME local pipeline
   * (skipped only for opt-in Direct chat, external.grounded=false); the
   * external generator builds its own message list, so the local llama.cpp
   * prompt above is untouched. Runs inside the engine queue (and the host's
   * generation mutex), so cancellation and timeouts always release it.
   */
  private async queryExternal(question: string, opts: EngineQueryOptions): Promise<EngineQueryResult> {
    const started = Date.now();
    const grounded = this.external.grounded();
    const context = grounded ? await this.stub.retrieveContext(question, opts.nResults) : null;
    const run = this.queue.then(async () => {
      const overrides = this.stub.generationOverrides();
      const result = await generateExternal({
        config: this.external.endpoint(),
        question,
        contextTexts: context?.texts ?? null,
        history: opts.history,
        ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
        ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
        streamCallback: opts.streamCallback,
        cancellationEvent: opts.cancellationEvent,
        airgap: this.external.airgap(),
        lookup: this.external.lookup,
        firstByteTimeoutMs: this.external.firstByteTimeoutMs,
        idleTimeoutMs: this.external.idleTimeoutMs,
      });
      const out: EngineQueryResult = {
        answer: result.answer,
        sources: context?.sources ?? [],
        context_length: context?.contextLength ?? 0,
        inference_time: (Date.now() - started) / 1000,
      };
      if (result.cancelled) out.cancelled = true;
      // Same grounded/general rule as the local path (C5, issue #72).
      out.grounding =
        !result.cancelled && context !== null && context.cited.length > 0 && context.floorActive ? 'grounded' : 'general';
      if (context !== null) out.cited = context.cited;
      if (!result.cancelled && context !== null && context.cited.length > 0 && this.learnAssembler !== null) {
        const learn = this.learnAssembler(context.cited, out.grounding);
        if (learn !== null) out.learn = learn;
      }
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** universal-provider-settings-overhaul: non-secret external.* snapshot (external.json). */
  externalSnapshot(): Record<string, unknown> {
    return { ...this.external.snapshot() };
  }

  /**
   * universal-provider-settings-overhaul: POST /settings/external/test. Lists
   * the draft endpoint's models and checks the chosen model. Key selection: a
   * key in the body (never persisted) is used for this probe; otherwise the
   * stored key ONLY when the draft URL's origin equals the key's bound origin;
   * otherwise no key is sent. Persists nothing.
   *
   * PR #142 review F-002: the whole test runs under one aggregate deadline
   * (listExternalModels), and `opts.signal` (the route aborts it when the
   * client disconnects) aborts the upstream request.
   */
  async probeExternal(
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ ok: boolean; kind?: string; message: string; models: string[] }> {
    const protocol = body.protocol === 'anthropic' ? 'anthropic' : body.protocol === 'openai' ? 'openai' : null;
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const draftKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (protocol === null) return { ok: false, kind: 'other', message: "protocol: expected 'openai' or 'anthropic'", models: [] };
    // The draft key is refused (never echoed) when it cannot travel in a header.
    if (!isHeaderSafeValue(draftKey)) return { ok: false, kind: 'other', message: `apiKey: ${UNSENDABLE_KEY_MESSAGE}`, models: [] };
    const verdict = validateEndpointUrl(baseUrl, { airgap: this.external.airgap() });
    if (!verdict.ok) return { ok: false, kind: 'other', message: verdict.message, models: [] };
    const apiKey = draftKey !== '' ? draftKey : this.external.keyFor(baseUrl);
    let models: string[];
    try {
      models = await listExternalModels({
        config: { protocol, baseUrl, model, apiKey },
        airgap: this.external.airgap(),
        lookup: this.external.lookup,
        ...(this.external.probeTimeoutMs !== undefined ? { totalTimeoutMs: this.external.probeTimeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        return { ok: false, kind: 'other', message: 'The connection test was cancelled.', models: [] };
      }
      if (err instanceof ExternalProviderError) {
        return { ok: false, kind: err.kind, message: scrubSecrets(err.message, apiKey), models: [] };
      }
      return { ok: false, kind: 'other', message: scrubSecrets(err instanceof Error ? err.message : String(err), apiKey), models: [] };
    }
    if (model !== '' && !models.includes(model)) {
      return {
        ok: false,
        kind: 'model',
        message: `Unknown model "${model}": ${originOf(baseUrl)} does not list it. Pick a model from the endpoint's list in Settings → Model & connection.`,
        models,
      };
    }
    return {
      ok: true,
      message: model === '' ? `Connected: ${models.length} model${models.length === 1 ? '' : 's'} available. Choose one.` : `Connected: ${model} is available.`,
      models,
    };
  }

  /** Test telemetry: how many backend constructions have completed. */
  getLoadCount(): number {
    return this.loads;
  }

  async getStats(): Promise<{
    document_count: number;
    chunk_count: number;
    embedding_model: string;
    llm_backend: string | null;
    documents: string[];
  }> {
    const profile = this.effectiveProfile();
    const stubStats = await this.stub.getStats();
    return {
      ...stubStats,
      // B6 (issue #64): when a store surface is attached, the real embedder id
      // (also what meta.embedding_model_id records) replaces the stub value.
      embedding_model:
        this.documents !== null ? this.documents.embedderModelId : stubStats.embedding_model,
      llm_backend: this.external.active()
        ? this.external.describe()
        : `llama.cpp (node-llama-cpp) profile=${profile} model=${path.basename(this.modelPathFor(profile))}`,
    };
  }

  applySettingsPatch(patch: Record<string, unknown>): { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] } {
    const inferenceSubset: Record<string, unknown> = {};
    const externalSubset: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith('inference.')) inferenceSubset[key] = value;
      else if (key.startsWith('external.')) externalSubset[key] = value;
      else rest[key] = value;
    }
    // universal-provider-settings-overhaul: every external.* key (incl. the
    // URL policy and airgap) is validated BEFORE anything commits; the
    // SecretStore write happens only on the commit path below.
    const externalErrors = Object.keys(externalSubset).length > 0 ? this.external.validate(externalSubset) : [];
    const errors: string[] = [];
    let profile: ProfileSetting | undefined;
    let thresholdGb: number | undefined;
    let threads: number | undefined;
    let vulkan: GpuSelection | undefined;
    for (const [key, value] of Object.entries(inferenceSubset)) {
      switch (key) {
        case 'inference.profile':
          if (value !== 'quality' && value !== 'fast' && value !== 'auto') {
            errors.push(`${key}: expected 'quality', 'fast', or 'auto'`);
          } else {
            profile = value;
          }
          break;
        case 'inference.profileThresholdGb':
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            errors.push(`${key}: expected a positive number`);
          } else {
            thresholdGb = value;
          }
          break;
        case 'inference.threads':
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < INFERENCE_THREADS_MIN ||
            value > INFERENCE_THREADS_MAX
          ) {
            errors.push(`${key}: expected an integer between ${INFERENCE_THREADS_MIN} and ${INFERENCE_THREADS_MAX}`);
          } else {
            threads = value;
          }
          break;
        case 'inference.vulkan':
          // issue #155: widened from a bare boolean so "let the probe decide"
          // is expressible. 'yes' and 1 stay invalid - a coerced truthy is not
          // a selection.
          if (value !== 'auto' && typeof value !== 'boolean') {
            errors.push(`${key}: expected 'auto', true or false`);
          } else {
            vulkan = value;
          }
          break;
        default:
          errors.push(`${key}: unknown inference setting`);
          break;
      }
    }
    if (errors.length > 0) {
      return { ok: false, status: 422, detail: 'Invalid inference settings', errors: [...errors, ...externalErrors] };
    }
    if (externalErrors.length > 0) {
      return { ok: false, status: 422, detail: 'Invalid external model settings', errors: externalErrors };
    }
    if (Object.keys(rest).length > 0) {
      const stubResult = this.stub.applySettingsPatch(rest);
      if (!stubResult.ok) return stubResult;
    }
    // Commit (all values validated above).
    for (const key of Object.keys(inferenceSubset)) {
      switch (key) {
        case 'inference.profile':
          this.profileSetting = profile as ProfileSetting;
          this.stickyAuto = null;
          break;
        case 'inference.profileThresholdGb':
          this.thresholdGb = thresholdGb as number;
          this.stickyAuto = null;
          break;
        case 'inference.threads':
          this.threadsSetting = threads;
          break;
        case 'inference.vulkan':
          this.vulkanSetting = vulkan;
          break;
        default:
          break;
      }
    }
    if (Object.keys(externalSubset).length > 0) {
      const wasActive = this.external.active();
      this.external.commit(externalSubset);
      // Switching to an external endpoint releases a resident local GGUF
      // (deferred behind any in-flight local generation).
      if (!wasActive && this.external.active()) {
        const release = this.queue.then(() => this.dispose());
        this.queue = release.catch(() => {});
      }
    }
    return { ok: true };
  }

  /**
   * PR #140 review (FB140-001): everything applySettingsPatch / resetSettings
   * can change — the stub's rag_* values and explicit key set, plus the
   * inference.* fields and the sticky AUTO latch an inference.profile /
   * profileThresholdGb patch clears. Resident-model and load state are not
   * settings and are never touched.
   *
   * PR #142 rebase RB-001: also the external.* state — the non-secret values,
   * the session-only key, and the two SecretStore entries — so a failed save
   * that touched external.* (above all external.apiKey) is undone too.
   */
  captureSettingsState(): LlamaSettingsState {
    return {
      stub: this.stub.captureSettingsState(),
      profileSetting: this.profileSetting,
      thresholdGb: this.thresholdGb,
      threadsSetting: this.threadsSetting,
      vulkanSetting: this.vulkanSetting,
      stickyAuto: this.stickyAuto,
      external: this.external.captureState(),
    };
  }

  /**
   * Restore a captureSettingsState() snapshot. Every in-memory value is
   * restored first; the SecretStore entries are then written back where they
   * differ, which THROWS when that write fails (the caller must then not
   * claim that nothing changed — see rollBackUnsavedSettings).
   */
  restoreSettingsState(snapshot: LlamaSettingsState): void {
    this.stub.restoreSettingsState(snapshot.stub);
    this.profileSetting = snapshot.profileSetting;
    this.thresholdGb = snapshot.thresholdGb;
    this.threadsSetting = snapshot.threadsSetting;
    this.vulkanSetting = snapshot.vulkanSetting;
    this.stickyAuto = snapshot.stickyAuto;
    this.external.restoreState(snapshot.external);
  }

  /**
   * settings-wiring-honesty: the reset directive. rag_* keys go to the stub;
   * external.* keys (universal-provider-settings-overhaul) restore their
   * defaults — resetting external.apiKey deletes BOTH secret entries (the key
   * and its bound origin). All-or-nothing: an unknown key commits nothing.
   */
  resetSettings(keys: unknown): { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] } {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) return this.stub.resetSettings(keys);
    const externalKeys = (keys as string[]).filter((key) => key.startsWith('external.'));
    const ragKeys = (keys as string[]).filter((key) => !key.startsWith('external.'));
    const known: readonly string[] = EXTERNAL_SETTING_KEYS;
    const unknown = externalKeys.filter((key) => !known.includes(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 422,
        detail: 'Request validation failed',
        errors: unknown.map((key) => `reset: ${key}: unknown setting`),
      };
    }
    if (ragKeys.length > 0 || externalKeys.length === 0) {
      const ragResult = this.stub.resetSettings(ragKeys);
      if (!ragResult.ok) return ragResult;
    }
    if (externalKeys.length > 0) this.external.reset(externalKeys);
    return { ok: true };
  }

  responseSettings(): Record<string, unknown> {
    return {
      // Effective generation values follow the profile the NEXT query uses
      // (effectiveProfile() may advance the sticky AUTO latch exactly as
      // modelStatus() does — see the PRR-240 note there).
      ...this.stub.responseSettings(profileGeneration(this.effectiveProfile())),
      'inference.profile': this.profileSetting,
      'inference.profileThresholdGb': this.thresholdGb,
      'inference.threads': this.effectiveThreads(),
      // issue #155: the operator's selection is what the setting round-trips
      // (so a saved 'auto' stays 'auto'); the resolved backend and the reason
      // ride on /status/models.
      'inference.vulkan': this.vulkanSetting ?? 'auto',
      // universal-provider-settings-overhaul: external.* (never the key).
      ...this.external.responseFields(),
    };
  }

  async search(query: string, nResults?: number): Promise<Array<{ text: string; source: string; similarity: number }>> {
    return this.stub.search(query, nResults);
  }

  /**
   * B6 (issue #64): the host attaches the store-backed document surface after
   * it opens the store. While no surface is attached, document methods keep
   * the stub's honest not-implemented behavior (the B3 conformance mode).
   */
  attachDocumentSurface(surface: DocumentSurface | null): void {
    this.documents = surface;
  }

  /**
   * B7 (issue #65): the host attaches the store-backed hybrid retrieval
   * surface after it opens the store (forwarded to the stub that owns the
   * retrieval seam). While null, search()/query() keep the stub's
   * deterministic detached behavior (the B3 conformance mode).
   */
  attachRetrievalSurface(surface: RetrievalSurface | null): void {
    this.stub.attachRetrievalSurface(surface);
  }

  /**
   * D6 (issue #82): the learn assembler is held by the llama engine itself
   * and consulted in query() when real retrieval produced cited chunks —
   * the same retrieveContext() seam the stub's own query() path uses.
   */
  attachLearnAssembler(assembler: LearnAssembler | null): void {
    this.learnAssembler = assembler;
  }

  private learnAssembler: LearnAssembler | null = null;

  /**
   * C3 (issue #70): the host attaches the store-backed pack lifecycle after
   * it opens the store (the same optional-attach pattern as the document
   * surface). Held so the API layer reaches the lifecycle through the engine,
   * exactly like documents/retrieval — never through host prototypes (the b3
   * duck-type pin reserves those for start/stop).
   */
  attachPackManager(manager: PackManager | null): void {
    this.packManager = manager;
  }

  /** The attached pack lifecycle (null until the host start path attaches). */
  get attachedPackManager(): PackManager | null {
    return this.packManager;
  }

  private packManager: PackManager | null = null;

  private documents: DocumentSurface | null = null;

  async listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }> {
    return this.documents !== null ? this.documents.listDocuments() : this.stub.listDocuments();
  }

  async clearDocuments(): Promise<void> {
    if (this.documents !== null) return this.documents.clearDocuments();
    return this.stub.clearDocuments();
  }

  async ingestDirectory(directory: string): Promise<IngestResult> {
    return this.documents !== null ? this.documents.ingestDirectory(directory) : this.stub.ingestDirectory(directory);
  }

  async ingestFile(input?: IngestFileInput): Promise<IngestResult> {
    return this.documents !== null ? this.documents.ingestFile(input) : this.stub.ingestFile(input);
  }

  async ingestBatch(inputs?: IngestFileInput[]): Promise<BatchIngestResult> {
    return this.documents !== null ? this.documents.ingestBatch(inputs) : this.stub.ingestBatch(inputs);
  }

  /** Best-effort teardown of the resident backend (tests, host shutdown). */
  async dispose(): Promise<void> {
    const resident = this.resident;
    this.resident = null;
    if (resident !== null) {
      await resident.backend.dispose().catch(() => {});
    }
  }
}
