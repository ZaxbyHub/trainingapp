// ingest/embedder.ts — embedding surface for the ingest pipeline (issue #64).
//
// Production embedder: transformers.js over the repo-staged
// bge-small-en-v1.5 ONNX weights (384-dim — the width B5's store records by
// default; ADR-0001 #55 may re-pin the model later, which is a config change
// here, not a schema change). Pooling follows the repo's established
// convention (web_ui/src/lib/embeddings/embedding.worker.ts: pooling 'cls',
// normalize: true). Empirically probed in plain Node (2026-09-09, trace
// 08-test-results): 351ms load, ~6ms/sequence, width 384, deterministic.
//
// HashEmbedder is the documented dev/CI fixture — selected explicitly via
// TRAININGAPP_DESKTOP_EMBEDDER=hash, the same pattern as
// TRAININGAPP_DESKTOP_ENGINE=stub — never a production default.
// Native code loads lazily (dynamic import), mirroring llama-engine: merely
// constructing the embedder — or running CI without touching embeddings —
// never loads onnxruntime.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelNotConfiguredError } from '../types.js';

export const EMBEDDER_ENV = 'TRAININGAPP_DESKTOP_EMBEDDER';
export const EMBEDDING_MODEL_DIR_ENV = 'TRAININGAPP_EMBEDDING_MODEL_DIR';
/** Model dir relative to a models root (matches the staged repo layout). */
export const DEFAULT_EMBEDDING_MODEL_SUBPATH = 'bge-small-en-v1.5';
export const ONNX_MODEL_SUBPATH = 'onnx/model.onnx';
/** A real weight file is ~133MB; a Git-LFS pointer is ~134 bytes. */
const STAGED_WEIGHTS_MIN_BYTES = 10 * 1024 * 1024;

export interface EmbeddingSurface {
  /** Identifier recorded into meta.embedding_model_id on first write. */
  readonly modelId: string;
  /** Embed texts; output vectors are L2-normalized. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic hash embedder for dev/CI: same text → same unit vector,
 * different text → different vector, any requested width. SHA-256 seeded so
 * values are stable across processes (never Math.random).
 */
export class HashEmbedder implements EmbeddingSurface {
  readonly modelId = 'hash';
  private readonly dims: number;

  constructor(options: { dims?: number } = {}) {
    const dims = options.dims ?? 384;
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`HashEmbedder dims must be a positive integer, got ${String(options.dims)}`);
    }
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const dims = this.dims;
    const vector = new Array<number>(dims);
    let digest = createHash('sha256').update(text, 'utf8').digest();
    for (let i = 0; i < dims; i += 1) {
      if (i * 2 >= digest.length) {
        digest = createHash('sha256').update(digest).digest();
      }
      // Two bytes per component: uniform-ish over [-1, 1).
      const value = digest.readUInt16BE((i * 2) % (digest.length - 1)) / 65535;
      vector[i] = value * 2 - 1;
    }
    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
    return vector.map((v) => v / (norm || 1));
  }
}

interface FeatureExtractionPipeline {
  (texts: string | string[], opts: { pooling: 'cls'; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
  dispose?(): Promise<void>;
}

/**
 * Production embedder over the staged ONNX weights. Constructing is cheap and
 * Electron-free; the first embed() lazily imports transformers.js + the native
 * onnxruntime binding and loads the model.
 */
export class OnnxEmbedder implements EmbeddingSurface {
  readonly modelId = DEFAULT_EMBEDDING_MODEL_SUBPATH;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(private readonly modelDir: string) {}

  /** The resolved ONNX weights directory (B7 routes embeds through its worker). */
  get weightsDir(): string {
    return this.modelDir;
  }

  /** Resolve and validate the weights location WITHOUT loading native code. */
  static stagedModelDir(candidates: Array<string | undefined>): string | null {
    for (const candidate of candidates) {
      if (!candidate || candidate.length === 0) continue;
      if (isValidModelDir(candidate)) return candidate;
    }
    return null;
  }

  private load(): Promise<FeatureExtractionPipeline> {
    if (this.pipelinePromise === null) {
      this.pipelinePromise = (async () => {
        const transformers = await import('@huggingface/transformers');
        const createPipeline = transformers.pipeline as unknown as (
          task: 'feature-extraction',
          modelPath: string,
          options: { dtype: string },
        ) => Promise<FeatureExtractionPipeline>;
        // fp32: the staged model.onnx is a full-precision export (a q8 sibling
        // would be selected via dtype when ADR-0001 stages one).
        return createPipeline('feature-extraction', this.modelDir, { dtype: 'fp32' });
      })();
      this.pipelinePromise.catch(() => {
        // Allow a retry after a transient failure (e.g. weights swapped in).
        this.pipelinePromise = null;
      });
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipeline = await this.load();
    const output = await pipeline(texts, { pooling: 'cls', normalize: true });
    return output.tolist();
  }

  async dispose(): Promise<void> {
    const pipeline = this.pipelinePromise;
    this.pipelinePromise = null;
    if (pipeline !== null) {
      const loaded = await pipeline.catch(() => null);
      await loaded?.dispose?.();
    }
  }
}

/** A usable model dir has the real ONNX weights staged (not an LFS pointer). */
function isValidModelDir(dir: string): boolean {
  const weights = path.join(dir, ONNX_MODEL_SUBPATH);
  try {
    return fs.statSync(weights).size >= STAGED_WEIGHTS_MIN_BYTES;
  } catch {
    return false;
  }
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

export interface ResolveEmbedderOptions {
  env?: Record<string, string | undefined>;
  /** Embedding width for the HashEmbedder fixture (store.dims in production). */
  dims: number;
  /** Electron injects app.getPath('userData'); models live under <userData>/models. */
  userDataPath?: string;
  /** Repository root (dev/CI); the staged models/ dir is the last candidate. */
  repoRoot?: string;
}

/**
 * Resolve the embedder for this process: `TRAININGAPP_DESKTOP_EMBEDDER=hash`
 * selects the deterministic fixture; anything else resolves the production
 * ONNX embedder's model dir (env override → <userData>/models → repo models/).
 * Throws ModelNotConfiguredError when production weights are not staged so
 * ingest can report the contract's honest "model not staged" failure instead
 * of a mid-write crash.
 */
export function resolveEmbedder(opts: ResolveEmbedderOptions): EmbeddingSurface {
  const env = opts.env ?? process.env;
  if (env[EMBEDDER_ENV] === 'hash') {
    return new HashEmbedder({ dims: opts.dims });
  }
  const explicit = env[EMBEDDING_MODEL_DIR_ENV];
  const staged =
    OnnxEmbedder.stagedModelDir([
      explicit,
      opts.userDataPath ? path.join(opts.userDataPath, 'models', DEFAULT_EMBEDDING_MODEL_SUBPATH) : undefined,
      opts.repoRoot
        ? path.join(opts.repoRoot, 'models', DEFAULT_EMBEDDING_MODEL_SUBPATH)
        : moduleWalkUp(path.dirname(fileURLToPath(import.meta.url)), path.join('models', DEFAULT_EMBEDDING_MODEL_SUBPATH)),
    ]) ?? (explicit !== undefined && explicit.length > 0 ? explicit : null);
  if (staged === null) {
    throw new ModelNotConfiguredError(
      `No embedding model staged. Expected ${DEFAULT_EMBEDDING_MODEL_SUBPATH}/${ONNX_MODEL_SUBPATH} under ` +
        'models/ (repo), <userData>/models, or set TRAININGAPP_EMBEDDING_MODEL_DIR to the model directory. ' +
        'Dev/CI can use the deterministic fixture via TRAININGAPP_DESKTOP_EMBEDDER=hash.',
    );
  }
  return new OnnxEmbedder(staged);
}

/** Headless default when no userData is known (dev tooling, CI). */
export function defaultUserDataPath(): string {
  return path.join(os.homedir(), '.trainingapp');
}
