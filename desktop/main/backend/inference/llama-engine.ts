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
import type { ChatHistoryItem } from 'node-llama-cpp';
import { StubEngine } from '../engine.js';
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
  RetrievalSurface,
} from '../types.js';
import { buildPenalties, PENALTY_FULL_CONTEXT_TOKENS, type PenaltyOptions } from './penalties.js';
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
    },
  ): Promise<{ answer: string; cancelled: boolean }>;
  dispose(): Promise<void>;
}

export interface LlamaEngineFactoryOptions {
  modelPath: string;
  threads: number;
  vulkan: boolean;
  /** Effective profile the factory call serves (drives generation params). */
  profile: InferenceProfileName;
}

export interface LlamaEngineOptions {
  /** Model root directory. Precedence over userDataPath and the headless default. */
  modelDir?: string;
  /** Electron injects app.getPath('userData'); models live under <userData>/models. */
  userDataPath?: string;
  profile?: ProfileSetting;
  profileThresholdGb?: number;
  threads?: number;
  /** Reserved (issue #62): off until A2 shows stability — llama.cpp #17389. */
  vulkan?: boolean;
  /** Explicit absolute model file overrides, keyed by profile. */
  models?: { quality?: string; fast?: string };
  /** Injectable seams for tests. */
  freeMemBytes?: () => number;
  cpuCount?: () => number;
  llamaFactory?: (opts: LlamaEngineFactoryOptions) => Promise<LlamaEngineBackend>;
}

/** Generation params per profile, mirroring the browser RAG presets
 *  (web_ui/src/lib/rag/rag-presets.ts:16-28: quality/fast rows). */
const PROFILE_GENERATION: Record<InferenceProfileName, { maxTokens: number; temperature: number }> = {
  quality: { maxTokens: 1024, temperature: 0.2 },
  fast: { maxTokens: 384, temperature: 0.3 },
};
const SAMPLER_TOP_P = 0.9;
const SAMPLER_REPEAT_PENALTY = 1.1;
const CONTEXT_SIZE = 8192; // DEFAULT_N_CTX parity (web_ui/src/lib/llm/wllama-service.ts:39)
const CANCEL_POLL_MS = 20;
// Bounds shared by the PUT /settings gate and the env-var ingress so neither
// path can reach createContext() with an unvalidated thread count.
export const INFERENCE_THREADS_MIN = 1;
export const INFERENCE_THREADS_MAX = 64;
// Carry at most this many history turns: the browser client caps at 6
// (buildHistorySnapshot), but the contract accepts unbounded arrays and an
// oversized history would overflow CONTEXT_SIZE on the resident model.
const MAX_HISTORY_TURNS = 12;

const SYSTEM_PROMPT =
  "You are TrainingApp's local assistant. Answer the user's question directly and concisely.";

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

/**
 * Prompt sampler options for a profile (PRR-011): the single place the
 * PROFILE_GENERATION/topP/penalties mapping is derived, exported so tests can
 * pin the shape that reaches session.prompt().
 */
export function buildGenerationParams(
  profile: InferenceProfileName,
  penalties: object = {},
): Record<string, unknown> {
  const generation = PROFILE_GENERATION[profile];
  return {
    maxTokens: generation.maxTokens,
    temperature: generation.temperature,
    topP: SAMPLER_TOP_P,
    ...(Object.keys(penalties).length > 0 ? { repeatPenalty: penalties } : {}),
  };
}

/** The production backend: node-llama-cpp over one resident loaded model. */
async function defaultLlamaFactory(opts: LlamaEngineFactoryOptions): Promise<LlamaEngineBackend> {
  // Dynamic import: native code loads only when a model is actually needed.
  const nlc = await import('node-llama-cpp');
  // CPU-only by default; the vulkan build is reserved until A2 certifies it
  // (llama.cpp #17389 — Gemma-3n E2B Vulkan crash on Intel iGPU).
  const llama = await nlc.getLlama(opts.vulkan ? { gpu: 'vulkan' } : { gpu: false });
  const model = await llama.loadModel({ modelPath: opts.modelPath });
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
      if (disposed) throw new Error('the inference backend has been disposed');
      if (genOpts.cancellationEvent?.isSet()) {
        return { answer: '', cancelled: true };
      }
      const penalties = buildPenalties({ repeatPenalty: SAMPLER_REPEAT_PENALTY } satisfies PenaltyOptions, PENALTY_FULL_CONTEXT_TOKENS);
      const abort = new AbortController();
      // Cancel bridge: the CancellationFlag polls at 20ms and aborts the
      // library prompt (stopOnAbortSignal) — emission stops far inside 200ms.
      const poll = setInterval(() => {
        if (genOpts.cancellationEvent?.isSet()) abort.abort();
      }, CANCEL_POLL_MS);
      const session = new nlc.LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: SYSTEM_PROMPT,
        autoDisposeSequence: false,
      });
      const seededHistory = historyToChatHistory(genOpts.history);
      if (seededHistory.length > 0) session.setChatHistory(seededHistory);
      try {
        const answer = await session.prompt(question, {
          onTextChunk(chunk: string) {
            genOpts.streamCallback?.(chunk);
          },
          signal: abort.signal,
          stopOnAbortSignal: true,
          ...buildGenerationParams(opts.profile, penalties),
        });
        return { answer, cancelled: genOpts.cancellationEvent?.isSet() ?? false };
      } finally {
        clearInterval(poll);
        // Statelessness: drop the session history so the next request starts
        // clean (the sequence KV is re-evaluated from the fresh history).
        session.resetChatHistory();
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
  overrides?: { userDataPath?: string },
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
    profile,
    ...(threads !== undefined ? { threads } : {}),
  });
}

interface ResidentEntry {
  backend: LlamaEngineBackend;
  profile: InferenceProfileName;
  inFlight: number;
}

export class LlamaEngine implements EngineSurface {
  /** rag_* settings + retrieval/document surfaces stay stub-owned (B5/B6/B7). */
  private readonly stub = new StubEngine();
  private readonly freeMemBytes: () => number;
  private readonly cpuCount: () => number;
  private readonly llamaFactoryFn: (opts: LlamaEngineFactoryOptions) => Promise<LlamaEngineBackend>;
  private profileSetting: ProfileSetting;
  private thresholdGb: number;
  private vulkanSetting: boolean | undefined;
  private threadsSetting: number | undefined;
  private readonly modelDirOption: string | undefined;
  private readonly userDataPath: string | undefined;
  private readonly modelOverrides: { quality?: string; fast?: string };
  private resident: ResidentEntry | null = null;
  private loads = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: LlamaEngineOptions = {}) {
    this.freeMemBytes = options.freeMemBytes ?? (() => os.freemem());
    this.cpuCount = options.cpuCount ?? (() => os.cpus().length);
    this.llamaFactoryFn = options.llamaFactory ?? defaultLlamaFactory;
    this.profileSetting = options.profile ?? 'auto';
    this.thresholdGb = options.profileThresholdGb ?? 6;
    this.vulkanSetting = options.vulkan;
    this.threadsSetting = options.threads;
    this.modelDirOption = options.modelDir;
    this.userDataPath = options.userDataPath;
    this.modelOverrides = options.models ?? {};
  }

  /** Headless-safe model dir: option -> <userData>/models -> ~/.trainingapp/models. */
  private resolveModelDir(): string {
    if (this.modelDirOption !== undefined && this.modelDirOption.length > 0) return this.modelDirOption;
    if (this.userDataPath !== undefined && this.userDataPath.length > 0) {
      return path.join(this.userDataPath, 'models');
    }
    return path.join(os.homedir(), '.trainingapp', 'models');
  }

  private effectiveProfile(): InferenceProfileName {
    return selectProfile(this.profileSetting, this.freeMemBytes(), this.thresholdGb);
  }

  private effectiveThreads(): number {
    return this.threadsSetting ?? defaultThreadCount(this.cpuCount());
  }

  private effectiveVulkan(): boolean {
    return this.vulkanSetting ?? false;
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
    this.assertModelAvailable(this.effectiveProfile());
  }

  private async ensureResident(profile: InferenceProfileName, modelPath: string): Promise<ResidentEntry> {
    if (this.resident !== null && this.resident.profile === profile) return this.resident;
    const old = this.resident;
    if (old !== null) {
      this.resident = null;
      // Profile switch defers to post-request: the per-engine queue means the
      // caller only reaches this point after prior generations completed, so
      // the old backend is idle and safe to dispose synchronously.
      await old.backend.dispose().catch(() => {});
    }
    const threads = this.effectiveThreads();
    let backend: LlamaEngineBackend;
    try {
      backend = await this.llamaFactoryFn({
        modelPath,
        threads,
        vulkan: this.effectiveVulkan(),
        profile,
      });
    } catch (err) {
      // Corrupt/unloadable model: wrap into the 503-diagnostic error type,
      // carrying the underlying failure for the operator.
      throw new ModelNotConfiguredError(
        `Failed to load the ${profile} model from ${modelPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loads += 1;
    const entry: ResidentEntry = { backend, profile, inFlight: 0 };
    this.resident = entry;
    return entry;
  }

  async query(question: string, opts: EngineQueryOptions = {}): Promise<EngineQueryResult> {
    const started = Date.now();
    const profile = this.effectiveProfile();
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
        const result = await entry.backend.generate(groundedQuestion, {
          history: opts.history,
          streamCallback: opts.streamCallback,
          cancellationEvent: opts.cancellationEvent,
        });
        const out: EngineQueryResult = {
          answer: result.answer,
          sources: context?.sources ?? [],
          context_length: context?.contextLength ?? 0,
          inference_time: (Date.now() - started) / 1000,
        };
        if (result.cancelled) out.cancelled = true;
        return out;
      } finally {
        entry.inFlight -= 1;
      }
    });
    this.queue = run.catch(() => {});
    return run;
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
      llm_backend: `llama.cpp (node-llama-cpp) profile=${profile} model=${path.basename(this.modelPathFor(profile))}`,
    };
  }

  applySettingsPatch(patch: Record<string, unknown>): { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] } {
    const inferenceSubset: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith('inference.')) inferenceSubset[key] = value;
      else rest[key] = value;
    }
    const errors: string[] = [];
    let profile: ProfileSetting | undefined;
    let thresholdGb: number | undefined;
    let threads: number | undefined;
    let vulkan: boolean | undefined;
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
          if (typeof value !== 'boolean') {
            errors.push(`${key}: expected a boolean`);
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
      return { ok: false, status: 422, detail: 'Invalid inference settings', errors };
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
          break;
        case 'inference.profileThresholdGb':
          this.thresholdGb = thresholdGb as number;
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
    return { ok: true };
  }

  responseSettings(): Record<string, unknown> {
    return {
      ...this.stub.responseSettings(),
      'inference.profile': this.profileSetting,
      'inference.profileThresholdGb': this.thresholdGb,
      'inference.threads': this.effectiveThreads(),
      'inference.vulkan': this.effectiveVulkan(),
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
