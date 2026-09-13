// build/embedder.ts — embedding surfaces for the pack build (issue #79).
//
// Mirrors desktop/main/backend/ingest/embedder.ts conventions so prebuilt
// pack vectors are query-compatible with the runtime by construction:
// production is transformers.js over repo-staged bge-small-en-v1.5 ONNX
// weights (384-dim, pooling 'cls', normalize true, fp32 — ADR-0001 #55 may
// re-pin later, which is a build-invocation change here, not a schema
// change); HashEmbedder is the deterministic dev/CI fixture, selected via
// --embedder hash, never a production default. Native code loads lazily
// (dynamic import) so merely constructing the embedder — or running CI with
// the hash fixture — never loads onnxruntime.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_EMBEDDING_MODEL_SUBPATH = 'bge-small-en-v1.5';
export const ONNX_MODEL_SUBPATH = 'onnx/model.onnx';
export const DEFAULT_EMBEDDING_DIMS = 384;
/** A real weight file is ~133MB; a Git-LFS pointer is ~134 bytes. */
const STAGED_WEIGHTS_MIN_BYTES = 10 * 1024 * 1024;

export interface EmbeddingSurface {
  /** Identifier recorded into pack.json embedding.model_id + meta. */
  readonly modelId: string;
  readonly dims: number;
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
  readonly dims: number;

  constructor(options: { dims?: number } = {}) {
    const dims = options.dims ?? DEFAULT_EMBEDDING_DIMS;
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
 * Production embedder over staged ONNX weights. Constructing is cheap; the
 * first embed() lazily imports transformers.js + the native onnxruntime
 * binding and loads the model.
 */
export class OnnxEmbedder implements EmbeddingSurface {
  readonly modelId: string;
  readonly dims: number;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private readonly modelDir: string,
    dims = DEFAULT_EMBEDDING_DIMS,
  ) {
    this.modelId = path.basename(modelDir);
    this.dims = dims;
  }

  private load(): Promise<FeatureExtractionPipeline> {
    if (this.pipelinePromise === null) {
      this.pipelinePromise = (async () => {
        const transformers = await import('@huggingface/transformers');
        const createPipeline = transformers.pipeline as unknown as (
          task: 'feature-extraction',
          modelPath: string,
          options: {
            dtype: string;
            session_options?: {
              intraOpNumThreads?: number;
              interOpNumThreads?: number;
              executionMode?: 'sequential' | 'parallel';
            };
          },
        ) => Promise<FeatureExtractionPipeline>;
        // fp32: the staged model.onnx is a full-precision export (a q8 sibling
        // would be selected via dtype when ADR-0001 stages one).
        // Single-threaded sequential execution pins ONNX CPU inference to a
        // deterministic reduction order: multi-threaded intra-op parallelism
        // reorders float accumulation, and a last-ulp vector difference would
        // break the reproducible-build contract (two real-corpus builds
        // differed in index.sqlite exactly this way before the pin).
        return createPipeline('feature-extraction', this.modelDir, {
          dtype: 'fp32',
          session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
        });
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

export interface ResolveBuildEmbedderOptions {
  /** 'hash' (hermetic fixture) or 'onnx' (production). */
  embedder: 'hash' | 'onnx';
  /** Explicit model dir (--embedding-model / TRAININGAPP_EMBEDDING_MODEL_DIR). */
  modelDir?: string;
  /** Repository root holding models/<subpath> (dev/CI default resolution). */
  repoRoot?: string;
  dims?: number;
}

/**
 * Resolve the embedder for a pack build. onnx throws a loud, actionable error
 * when no staged weights are found (never a mid-build native crash); hash is
 * always available.
 */
export function resolveBuildEmbedder(opts: ResolveBuildEmbedderOptions): EmbeddingSurface {
  if (opts.embedder === 'hash') {
    return new HashEmbedder({ dims: opts.dims });
  }
  const explicit = opts.modelDir ?? process.env['TRAININGAPP_EMBEDDING_MODEL_DIR'];
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);
  if (opts.repoRoot !== undefined) {
    candidates.push(path.join(opts.repoRoot, 'models', DEFAULT_EMBEDDING_MODEL_SUBPATH));
  }
  const staged = candidates.find((candidate) => isValidModelDir(candidate));
  if (staged === undefined) {
    throw new Error(
      `No embedding model staged for the onnx embedder. Expected ` +
        `${DEFAULT_EMBEDDING_MODEL_SUBPATH}/${ONNX_MODEL_SUBPATH} under models/ (repo) or pass ` +
        `--embedding-model <dir> with ${ONNX_MODEL_SUBPATH} inside. ` +
        `Hermetic builds can use --embedder hash.`,
    );
  }
  return new OnnxEmbedder(staged, opts.dims);
}
