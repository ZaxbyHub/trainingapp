/**
 * Embedding service using Transformers.js with ONNX runtime.
 *
 * OFFLINE-FIRST (Phase 1): the model is loaded exclusively from locally packaged
 * assets under `web_ui/public/models/embeddings/` — never from the HuggingFace CDN.
 * This is required for the fully self-contained, air-gapped / STIG-scannable archive.
 * See PACKAGING.md and scripts/prepare-models.mjs for how the weights are bundled.
 *
 * Uses Snowflake/snowflake-arctic-embed-m-v1.5 model (768-dim, q8 ~110MB),
 * loaded from `${EMBEDDING_MODELS_BASE}/snowflake-arctic-embed-m-v1.5/`.
 * Issue #37 R9 swapped from bge-small-en-v1.5 (384-dim, fp32 ~130MB).
 *
 * Worker liveness (U9, #268 / R4): every worker failure — an `error`/
 * `messageerror` event, an init handshake that never completes, or a request
 * that never gets a reply — routes through ONE idempotent failure path that
 * terminates the worker, settles every pending request exactly once, drops
 * readiness, nulls the init promise (so a later initialize() constructs a
 * NEW worker and the orchestrator's next readiness check retries), and
 * marks the session's retrieval health keyword-only with the cause.
 * Handlers and timeout closures capture the CONSTRUCTED worker instance, so
 * a late event from an already-replaced worker cannot pass the new current
 * worker into the failure path.
 */

import type {
  EmbeddingVector,
  EmbeddingResult,
  EmbeddingModelInfo,
  EmbeddingProgressCallback,
} from '../../types/embedding';
import { EMBEDDING_MODEL_PATH } from '../models/model-manifest';
import { configureOfflineEnv } from '../models/offline-env';
import { assertEmbeddingModelStaged } from './embedding-staging';
import { setKeywordOnly } from '../rag/retrieval-health';

// Model configuration.
// Issue #37 R9: swapped bge-small-en-v1.5 (384-dim) → snowflake-arctic-embed-
// m-v1.5 (768-dim, +3.5 nDCG@10 on MTEB-v1). `MODEL_NAME` keeps the canonical
// id for display/telemetry; `MODEL_PATH` is the path resolved against
// `env.localModelPath` (= /models), i.e. `embeddings/snowflake-arctic-embed-m-v1.5`.
const MODEL_NAME = 'Snowflake/snowflake-arctic-embed-m-v1.5';
const MODEL_PATH = EMBEDDING_MODEL_PATH;
const EMBEDDING_DIMENSIONS = 768;

/**
 * Bounded no-reply window per encode/encodeBatch request (U9): a worker
 * that never replies must not hang the caller forever.
 */
export const EMBEDDING_REPLY_TIMEOUT_MS = 30_000;

/**
 * Bounded init-handshake window (U9): a worker whose init reply never
 * arrives must not hang initialize() forever.
 */
export const EMBEDDING_INIT_TIMEOUT_MS = 60_000;

/**
 * Internal type for correlating Worker request/reply pairs.
 * Each pending encode/encodeBatch call gets a unique id whose
 * resolve/reject pair is stored here until the Worker replies.
 */
interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  /**
   * #273 (C14): batch-progress messages carry the request id, so progress is
   * routed to THIS request's callback only — never to another concurrent
   * request's callback, and never to a request that already settled (the
   * entry is deleted on result/error).
   */
  onProgress?: EmbeddingProgressCallback;
  /** U9: the per-request bounded no-reply timer (cleared on reply/failure). */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Issue #37 R8: the actual embedding work runs in a Web Worker
 * (embedding.worker.ts) so the transformers.js pipeline and its WASM
 * forward passes never block the main thread.  This module-level variable
 * holds the one Worker instance, created once during doInitialize() and
 * terminated during dispose(). */
let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();
/** U9: reject half of the in-flight init promise, for the failure path. */
let initReject: ((reason: unknown) => void) | null = null;
/** U9: the armed init-handshake bound, cleared on the `ready` reply. */
let initTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Singleton embedding service for browser-local embeddings.
 * Handles model loading, caching, and text encoding.
 */
export class EmbeddingService {
  private static instance: EmbeddingService | null = null;

  private modelInfo: EmbeddingModelInfo;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;
  private disposed: boolean = false;

  /**
   * Get the singleton instance, creating it if necessary.
   */
  static getInstance(): EmbeddingService {
    if (EmbeddingService.instance === null) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /**
   * Private constructor for singleton pattern.
   */
  private constructor() {
    this.modelInfo = {
      name: MODEL_NAME,
      dimensions: EMBEDDING_DIMENSIONS,
      cached: false,
    };
    this.configureEnv();
  }

  /**
   * Configure Transformers.js for OFFLINE, locally-packaged usage.
   *
   * Delegates to the shared `configureOfflineEnv()` so every Transformers.js
   * consumer writes identical settings to the shared global `env` — see
   * offline-env.ts for why this must be centralized.
   */
  private configureEnv(): void {
    configureOfflineEnv();
  }

  /**
   * Initialize the embedding model.
   * Loads the model from cache or downloads if needed.
   * Subsequent calls return the same promise.
   *
   * @returns Promise that resolves when model is loaded
   * @throws Error if model loading fails
   */
  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    // Return existing promise if initialization is in progress
    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * Internal initialization logic — Issue #37 R8.
   *
   * Creates a Web Worker (embedding.worker.ts) and delegates the
   * transformers.js pipeline creation to it so WASM forward passes
   * never block the main thread.
   */
  private async doInitialize(): Promise<void> {
    if (worker) {
      this.ready = true;
      return;
    }

    try {
      configureOfflineEnv();

      // U8 (#268): in PROD builds ONLY (packaged Electron renderer, vite
      // preview, offline build serve), probe the staged config asset BEFORE
      // constructing the worker. An SPA-fallback HTML 200 at the config
      // path would otherwise be fed to the worker as the model config and
      // die with an inscrutable error; here it fails closed with a staging
      // error that names the URL. Dev/test environments skip this probe
      // entirely (their asset serving differs and their suites do not stub
      // fetch).
      if (import.meta.env.PROD) {
        await assertEmbeddingModelStaged();
        // PR #285 review (PRR-008): the probe await is a disposal window —
        // without this check the old continuation resumes, constructs a
        // worker, and overwrites the module-level init bound/reject of any
        // attempt the singleton restart made in the meantime.
        if (this.disposed) {
          throw new Error('EmbeddingService was disposed during initialization');
        }
      }

      await this._initWithWorker();

      if (this.disposed) {
        throw new Error('EmbeddingService was disposed during initialization');
      }
      this.ready = true;
    } catch (error) {
      // PR #285 review (PRR-008, round 2): this catch touches NO module
      // state — worker termination and the init bound/reject teardown are
      // ownership-scoped inside _initWithWorker (which knows the worker it
      // constructed), so a stale disposed-probe continuation (which never
      // constructed anything) cannot strip the CURRENT attempt's worker,
      // bound, reject, or in-flight pendings. Only INSTANCE state is
      // cleared here.
      this.initPromise = null;
      throw new Error(
        `Failed to initialize embedding model: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Initialize via the embedding Worker (off-main-thread pipeline).
   * Sends an `init` message; the Worker replies with `ready` containing
   * the model dimensions, or `error` on failure.
   */
  private async _initWithWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        // Capture the constructed instance (U9): every handler and bound
        // below closes over `w`, never the mutable module `worker` variable,
        // so a late event from an already-replaced worker carries the OLD
        // instance and failWorker's identity guard makes it a no-op.
        const w = new Worker(
          new URL('./embedding.worker.ts', import.meta.url),
          { type: 'module' }
        );
        worker = w;

        w.onmessage = (event: MessageEvent) => {
          const msg = event.data;
          // PR #285 review (PRR-008): only the CURRENT attempt's worker may
          // disarm the module-level init bound/reject — a late message from
          // a replaced/disposed worker must not clear the live attempt's
          // state.
          const isCurrent = worker === w;
          if (msg.kind === 'ready') {
            if (isCurrent) {
              this.modelInfo.dimensions = msg.dimensions;
              this.modelInfo.cached = true;
              initReject = null;
              initTimerClear();
            }
            resolve();
          } else if (msg.kind === 'error' && msg.id === -1) {
            if (isCurrent) {
              initReject = null;
              initTimerClear();
              // PR #285 review (PRR-008, round 2): ownership-scoped teardown
              // — this attempt's worker failed to initialize, so terminate
              // and clear exactly what THIS attempt constructed.
              try {
                w.terminate();
              } catch {
                /* best-effort */
              }
              if (worker === w) worker = null;
              pendingRequests.clear();
            }
            reject(new Error(msg.message));
          } else if (msg.kind === 'batch-progress') {
            // #273 (C14): the worker posts batch-progress during encodeBatch;
            // route it by request id to that request's callback only.
            const pending = pendingRequests.get(msg.id);
            if (pending?.onProgress) {
              pending.onProgress(msg.processed, msg.total);
            }
          } else if (msg.kind === 'encode-result' || msg.kind === 'encodeBatch-result' || msg.kind === 'error') {
            const pending = pendingRequests.get(msg.id);
            if (pending) {
              // Deleting the entry (and its bound) also retires its progress
              // callback and timer: a late/stray progress message or timer
              // fire for a settled request finds no pending entry and is
              // dropped.
              pendingRequests.delete(msg.id);
              if (pending.timer) clearTimeout(pending.timer);
              if (msg.kind === 'error') {
                pending.reject(new Error(msg.message));
              } else {
                pending.resolve(msg);
              }
            }
          }
        };

        // Persistent handlers on the CAPTURED instance (U9) — kept across
        // the worker's lifetime, not only inside the init promise closure.
        w.onerror = (err: ErrorEvent) => {
          this.failWorker(w, new Error(`Embedding worker failed: ${err.message}`));
        };
        w.onmessageerror = () => {
          this.failWorker(w, new Error('Embedding worker message deserialization failed'));
        };

        // Init handshake bound (U9): a worker whose `ready` reply never
        // arrives fails through the same idempotent path instead of hanging
        // initialize() forever. Cleared by the `ready` reply above.
        initTimer = setTimeout(() => {
          this.failWorker(
            w,
            new Error(`Embedding worker init timed out after ${EMBEDDING_INIT_TIMEOUT_MS} ms`)
          );
        }, EMBEDDING_INIT_TIMEOUT_MS);
        initReject = reject;

        w.postMessage({
          kind: 'init',
          modelPath: MODEL_PATH,
          dimensions: EMBEDDING_DIMENSIONS,
        });
      } catch (err) {
        reject(new Error(
          `Failed to create embedding Worker: ${err instanceof Error ? err.message : String(err)}`
        ));
      }
    });
  }

  /**
   * ONE idempotent worker-failure path (U9, #268 / R4):
   * 1. identity guard — a stale event from an already-replaced worker is a
   *    no-op (it carries the OLD captured instance, which no longer matches
   *    the module `worker`);
   * 2. detach — terminate the failed worker, clear it, drop readiness, and
   *    null the init promise so a later initialize() constructs a NEW
   *    worker;
   * 3. settle — collect pending requests, clear the map and every timer
   *    FIRST, then reject each collected entry exactly once (delete-before-
   *    reject makes double-reject structurally impossible; a timeout arm
   *    removes its own entry before invoking this path);
   * 4. health — mark the session's retrieval health keyword-only with the
   *    cause (the orchestrator's transition logic keeps repeats idempotent).
   */
  private failWorker(failedWorker: Worker, cause: Error): void {
    if (worker !== failedWorker) return;

    worker = null;
    this.ready = false;
    this.initPromise = null;
    try {
      failedWorker.terminate();
    } catch {
      /* best-effort */
    }
    initTimerClear();
    if (initReject !== null) {
      const reject = initReject;
      initReject = null;
      reject(cause);
    }

    // Settle exactly once: collect, clear map + timers first, then reject.
    const entries = Array.from(pendingRequests.values());
    pendingRequests.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    for (const entry of entries) {
      entry.reject(cause);
    }

    setKeywordOnly(cause.message);
  }

  /**
   * Check if the model is ready for encoding.
   */
  isReady(): boolean {
    return this.ready && worker !== null;
  }

  /**
   * Get model metadata.
   */
  getModelInfo(): EmbeddingModelInfo {
    return { ...this.modelInfo };
  }

  /**
   * Post a message to the worker and await the reply.
   * Each request gets a unique correlation id stored in
   * pendingRequests until the worker replies. The module `worker` is read
   * ONCE at post time into `posted` (U9): the bounded no-reply timer closes
   * over the instance the request was actually posted to, so a replacement
   * worker can never be failed for this request's stall.
   */
  private _postAndWait(
    msg: Record<string, unknown>,
    onProgress?: EmbeddingProgressCallback
  ): Promise<unknown> {
    const id = nextRequestId++;
    const posted = worker;
    if (!posted) {
      return Promise.reject(
        new Error('EmbeddingService not initialized. Call initialize() first.')
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pendingRequests.get(id);
        if (!entry) return;
        // Remove this entry (and its timer) BEFORE invoking the failure
        // path: failWorker then rejects only the REMAINING pendings, so no
        // promise is rejected twice.
        pendingRequests.delete(id);
        clearTimeout(timer);
        const timeoutError = new Error(
          `Embedding worker reply timed out after ${EMBEDDING_REPLY_TIMEOUT_MS} ms`
        );
        reject(timeoutError);
        this.failWorker(posted, timeoutError);
      }, EMBEDDING_REPLY_TIMEOUT_MS);
      pendingRequests.set(id, { resolve, reject, timer, ...(onProgress ? { onProgress } : {}) });
      posted.postMessage({ id, ...msg });
    });
  }

  /**
   * Encode a single text into an embedding vector.
   *
   * @param text - Text to encode
   * @returns Promise resolving to 768-dimensional Float32Array
   * @throws Error if service is not initialized or encoding fails
   */
  async encode(text: string): Promise<EmbeddingVector> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot encode empty text');
    }

    const result = await this._postAndWait({ kind: 'encode', text }) as {
      kind: 'encode-result';
      id: number;
      vector: Float32Array;
    };

    if (result.vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${result.vector.length}`
      );
    }
    return result.vector;
  }

  /**
   * Encode multiple texts with progress tracking.
   * Processes in batches for memory efficiency.
   *
   * @param texts - Array of texts to encode
   * @param onProgress - Optional callback for progress updates
   * @returns Promise resolving to array of embedding vectors
   * @throws Error if service is not initialized or any encoding fails
   */
  async encodeBatch(
    texts: string[],
    onProgress?: EmbeddingProgressCallback
  ): Promise<EmbeddingVector[]> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    for (let i = 0; i < texts.length; i++) {
      if (typeof texts[i] !== 'string') {
        throw new Error(`Text at index ${i} is not a string`);
      }
    }

    const result = await this._postAndWait(
      {
        kind: 'encodeBatch',
        texts,
      },
      onProgress
    ) as {
      kind: 'encodeBatch-result';
      id: number;
      vectors: Float32Array[];
    };

    return result.vectors;
  }

  /**
   * Encode a text and return full result metadata.
   *
   * @param text - Text to encode
   * @returns Promise resolving to EmbeddingResult
   */
  async encodeWithMetadata(text: string): Promise<EmbeddingResult> {
    const vector = await this.encode(text);
    return {
      vector,
      text,
      dimensions: EMBEDDING_DIMENSIONS,
    };
  }

  /**
   * Dispose of the service and release resources.
   * Call when done using the embedding service.
   */
  dispose(): void {
    this.disposed = true;
    const w = worker;
    worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        /* best-effort */
      }
    }
    initTimerClear();
    if (initReject !== null) {
      const reject = initReject;
      initReject = null;
      // Same message as doInitialize's post-init disposed check so callers
      // observe one stable dispose-race failure text either way.
      reject(new Error('EmbeddingService was disposed during initialization'));
    }
    // Reject (never silently drop) in-flight requests (U9): callers awaiting
    // encode/encodeBatch must observe the disposal instead of hanging.
    const entries = Array.from(pendingRequests.values());
    pendingRequests.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    const disposeError = new Error('EmbeddingService disposed with requests in flight');
    for (const entry of entries) {
      entry.reject(disposeError);
    }
    this.ready = false;
    this.initPromise = null;
    this.modelInfo.cached = false;
    EmbeddingService.instance = null;
  }
}

/** Clear the armed init-handshake bound if one is pending. */
function initTimerClear(): void {
  if (initTimer !== undefined) {
    clearTimeout(initTimer);
    initTimer = undefined;
  }
}

/**
 * Convenience function to get the embedding service instance.
 */
export function getEmbeddingService(): EmbeddingService {
  return EmbeddingService.getInstance();
}
