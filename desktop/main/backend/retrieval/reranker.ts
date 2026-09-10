// retrieval/reranker.ts — worker-thread cross-encoder reranker runner (B7/#65).
//
// WorkerReranker keeps ONE dedicated node:worker_threads Worker alive and
// serializes rerank jobs through it (per-instance jobId counter + pending
// map; results resolve by jobId, not call order). The whole point of the
// thread is AC4: ONNX inference is synchronous native compute, so running it
// on the main/event-loop thread would stall /health (the defect the issue
// explicitly forbids reproducing from web_ui reranker.ts).
//
// The worker is spawned LAZILY on the first score() call: constructing the
// runner is cheap and weight-free, and hosts that never serve a reranked query
// never pay for a thread or a model load. dispose() terminates the worker,
// rejects every in-flight job, and is idempotent.
import { Worker } from 'node:worker_threads';
import type { RerankerSurface } from './hybrid.js';

export type { RerankerSurface };
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export interface RerankerRunnerOptions {
  /** Worker entry; defaults to the compiled rerank-worker.js sibling of this module. */
  workerPath?: string;
  /** Forwarded to the worker via workerData (the ettin model dir). */
  modelDir?: string;
  /** Forwarded via workerData: the bge-small model dir for embed jobs. */
  embedModelDir?: string;
}

interface RerankJob {
  kind: 'rerank';
  jobId: number;
  query: string;
  candidates: string[];
}

type WorkerResponse =
  | { kind: 'rerank:result'; jobId: number; scores: number[] }
  | { kind: 'rerank:error'; jobId: number; message: string }
  | { kind: 'embed:result'; jobId: number; vectors: number[][] }
  | { kind: 'embed:error'; jobId: number; message: string };

interface PendingJob {
  resolve: (payload: number[] | number[][]) => void;
  reject: (err: Error) => void;
}

/** A real reranker weight file is ~127MB; a Git-LFS pointer is ~134 bytes. */
export const RERANKER_WEIGHTS_MIN_BYTES = 10 * 1024 * 1024;

/** Model dir relative to a models root (matches the staged repo layout). */
export const DEFAULT_RERANKER_MODEL_SUBPATH = 'ettin-reranker-32m-v1';
export const RERANKER_MODEL_DIR_ENV = 'TRAININGAPP_RERANKER_MODEL_DIR';
export { RERANKER_WEIGHTS_MIN_BYTES as STAGED_RERANKER_WEIGHTS_MIN_BYTES };

function defaultWorkerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'rerank-worker.js');
}

function isValidModelDir(dir: string): boolean {
  for (const candidate of [path.join(dir, 'onnx', 'model_quantized.onnx'), path.join(dir, 'onnx', 'model.onnx')]) {
    try {
      if (fs.statSync(candidate).size >= RERANKER_WEIGHTS_MIN_BYTES) return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

function moduleWalkUp(startDir: string, relative: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 32; i += 1) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface ResolveRerankerOptions {
  env?: Record<string, string | undefined>;
  /** Electron injects app.getPath('userData'); models live under <userData>/models. */
  userDataPath?: string;
  /** Repository root (dev/CI); the staged models/ dir is the last candidate. */
  repoRoot?: string;
}

/**
 * Resolve the staged reranker model dir WITHOUT loading native code or
 * spawning a worker. Returns null when nothing usable is staged — the caller
 * (the host) then degrades to RRF-only retrieval with no relevance floor,
 * exactly like rerank disabled.
 */
export function resolveRerankerModelDir(opts: ResolveRerankerOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const explicit = env[RERANKER_MODEL_DIR_ENV];
  const candidates = [
    explicit,
    opts.userDataPath ? path.join(opts.userDataPath, 'models', DEFAULT_RERANKER_MODEL_SUBPATH) : undefined,
    opts.repoRoot ? path.join(opts.repoRoot, 'models', DEFAULT_RERANKER_MODEL_SUBPATH) : undefined,
    moduleWalkUp(path.dirname(fileURLToPath(import.meta.url)), path.join('models', DEFAULT_RERANKER_MODEL_SUBPATH)),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0 && isValidModelDir(candidate)) return candidate;
  }
  return null;
}

export class WorkerReranker {
  private worker: Worker | null = null;
  private workerPath: string;
  private modelDir?: string;
  private embedModelDir?: string;
  private nextJobId = 1;
  private pending = new Map<number, PendingJob>();
  private disposed = false;

  constructor(options: RerankerRunnerOptions = {}) {
    this.workerPath = options.workerPath ?? defaultWorkerPath();
    this.modelDir = options.modelDir;
    this.embedModelDir = options.embedModelDir;
  }

  private ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('WorkerReranker has been disposed');
    }
    if (this.worker === null) {
      const worker = new Worker(this.workerPath, {
        workerData: { modelDir: this.modelDir ?? null, embedModelDir: this.embedModelDir ?? null },
      });
      worker.on('message', (raw: unknown) => {
        const message = raw as WorkerResponse;
        if (!message || typeof message.jobId !== 'number') return;
        const job = this.pending.get(message.jobId);
        if (!job) return;
        this.pending.delete(message.jobId);
        if (message.kind === 'rerank:result' && Array.isArray(message.scores)) {
          job.resolve(message.scores);
        } else if (message.kind === 'embed:result' && Array.isArray(message.vectors)) {
          job.resolve(message.vectors);
        } else if ((message.kind === 'rerank:error' || message.kind === 'embed:error')) {
          job.reject(new Error(message.message));
        } else {
          job.reject(new Error(`unexpected rerank worker message: ${String((message as { kind?: unknown }).kind)}`));
        }
      });
      worker.on('error', (err) => this.failAll(err));
      worker.on('exit', (code) => {
        if (code !== 0) this.failAll(new Error(`rerank worker exited with code ${code}`));
        if (this.worker === worker) this.worker = null;
      });
      this.worker = worker;
    }
    return this.worker;
  }

  private failAll(err: Error): void {
    for (const [jobId, job] of this.pending) {
      this.pending.delete(jobId);
      job.reject(err);
    }
  }

  /** Score candidates against the query (cross-encoder sigmoid scores). */
  async score(query: string, candidates: string[]): Promise<number[]> {
    const worker = this.ensureWorker();
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    const job: RerankJob = { kind: 'rerank', jobId, query, candidates };
    return new Promise<number[]>((resolve, reject) => {
      this.pending.set(jobId, {
        resolve: (payload) => resolve(payload as number[]),
        reject,
      });
      worker.postMessage(job);
    });
  }

  /**
   * Embed texts through the worker's bge pipeline (same single ORT thread as
   * rerank). Only meaningful when the worker was constructed with an
   * embedModelDir; the WorkerEmbedder proxy is the intended entry point.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const worker = this.ensureWorker();
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    const job = { kind: 'embed' as const, jobId, texts };
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(jobId, {
        resolve: (payload) => resolve(payload as number[][]),
        reject,
      });
      worker.postMessage(job);
    });
  }

  /** Terminate the worker, reject in-flight jobs, idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      await worker.terminate();
    }
    if (this.pending.size > 0) {
      const err = new Error('WorkerReranker disposed with jobs in flight');
      // Defer one macrotask: a caller that awaits dispose() and only THEN
      // attaches a rejection handler to the in-flight job (the frozen C4
      // pattern) would otherwise trip Node's unhandled-rejection detector,
      // because the rejection would fire before the handler exists.
      setImmediate(() => this.failAll(err));
    }
  }
}

/**
 * Main-thread proxy that routes embeddings through the retrieval worker so
 * onnxruntime stays on a SINGLE thread of this process (cross-thread ort
 * aborts the process; see rerank-worker.ts header). Satisfies the same
 * EmbeddingSurface contract as ingest/embedder.ts.
 */
export class WorkerEmbedder {
  readonly modelId: string;
  constructor(
    private readonly worker: WorkerReranker,
    modelId: string,
  ) {
    this.modelId = modelId;
  }

  embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    return this.worker.embed(texts);
  }
}
