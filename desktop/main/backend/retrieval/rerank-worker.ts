// retrieval/rerank-worker.ts — the PRODUCTION retrieval worker entry (B7/#65).
//
// Runs in a dedicated node:worker_threads thread. This worker owns ALL
// onnxruntime work for retrieval: cross-encoder reranking AND query
// embedding. Single-thread ORT ownership is REQUIRED: onnxruntime-node 1.21
// aborts the whole process (fatal, exit 134) when the same module is used
// from TWO threads of one process — empirically probed 2026-09-09 (main
// embed -> worker rerank -> main embed = abort; trace repro/mix-probe.mjs).
// The host therefore never calls ORT on the main thread when this worker
// exists (WorkerEmbedder proxies query/ingest embeddings here).
//
// Message protocol (rerank half pinned by C4):
//   main  -> worker: { kind: 'rerank', jobId, query, candidates }
//                  | { kind: 'embed',  jobId, texts }
//   worker -> main:  { kind: 'rerank:result', jobId, scores }
//                or  { kind: 'rerank:error',   jobId, message }
//                or  { kind: 'embed:result',   jobId, vectors }
//                or  { kind: 'embed:error',    jobId, message }
//
// Models: ettin-reranker-32m-v1 (the web_ui baseline reranker,
// web_ui/src/lib/models/model-manifest.ts:72-76) and bge-small-en-v1.5
// (ADR-0006 pin) via transformers.js over the native onnxruntime backend
// (fp32 for bge, matching ingest/embedder.ts; q8 for ettin, matching the
// browser baseline reranker.ts:179-208). Scoring bypasses the
// text-classification pipeline's softmax (a single logit collapses to 1.0)
// and applies sigmoid(logit) per (query, candidate) pair — the baseline
// semantics (reranker.ts:7-13, 312-320). ADR-0001 (#55) may re-pin the
// models; that is a modelDir/config change, not a protocol change.
import { parentPort, workerData } from 'node:worker_threads';

type WorkerJob =
  | { kind: 'rerank'; jobId: number; query: string; candidates: string[] }
  | { kind: 'embed'; jobId: number; texts: string[] };

interface TokenizeOutput {
  tensors: Record<string, { data: unknown; dims: number[] }>;
}

interface RerankModel {
  (inputs: unknown): Promise<{ logits: { data: Float32Array | BigInt64Array | number[]; dims: number[] } }>;
}

interface Tokenizer {
  (
    text: string | string[],
    opts?: { text_pair?: string | string[]; padding?: boolean; truncation?: boolean },
  ): Promise<TokenizeOutput>;
}

interface EmbedOutput {
  tolist(): number[][];
}

interface EmbedPipeline {
  (texts: string[], opts: { pooling: 'cls'; normalize: boolean }): Promise<EmbedOutput>;
}

let rerankPromise: Promise<{ tokenizer: Tokenizer; model: RerankModel }> | null = null;
let embedPromise: Promise<EmbedPipeline> | null = null;

function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

async function loadRerank(modelDir: string): Promise<{ tokenizer: Tokenizer; model: RerankModel }> {
  if (rerankPromise === null) {
    rerankPromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      const tokenizer = (await transformers.AutoTokenizer.from_pretrained(modelDir)) as unknown as Tokenizer;
      const model = (await transformers.AutoModelForSequenceClassification.from_pretrained(modelDir, {
        dtype: 'q8',
      })) as unknown as RerankModel;
      return { tokenizer, model };
    })();
    rerankPromise.catch(() => {
      // Allow a retry after a transient load failure (weights swapped in).
      rerankPromise = null;
    });
  }
  return rerankPromise;
}

async function loadEmbed(modelDir: string): Promise<EmbedPipeline> {
  if (embedPromise === null) {
    embedPromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      const createPipeline = transformers.pipeline as unknown as (
        task: 'feature-extraction',
        modelPath: string,
        options: { dtype: string },
      ) => Promise<EmbedPipeline>;
      return createPipeline('feature-extraction', modelDir, { dtype: 'fp32' });
    })();
    embedPromise.catch(() => {
      embedPromise = null;
    });
  }
  return embedPromise;
}

async function scoreBatch(
  rerankModelDir: string,
  query: string,
  candidates: string[],
): Promise<number[]> {
  if (candidates.length === 0) return [];
  const { tokenizer, model } = await loadRerank(rerankModelDir);
  // True pair encoding ([CLS] query [SEP] candidate [SEP]) with token_type_ids.
  // transformers.js requires text and text_pair to be the SAME shape: pass the
  // query repeated per candidate as the text array and the candidates as the
  // text_pair array, keeping the (query, candidate) order of every pair.
  const inputs = await tokenizer(candidates.map(() => query), {
    text_pair: candidates,
    padding: true,
    truncation: true,
  });
  const output = await model(inputs);
  const logits = output.logits;
  const width = logits.dims.length >= 2 ? Number(logits.dims[1] ?? 1) : 1;
  const scores: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const value = logits.data[index * width];
    scores.push(sigmoid(typeof value === 'number' ? value : Number(value)));
  }
  return scores;
}

const port = parentPort;
if (port !== null) {
  port.on('message', (raw: unknown) => {
    void (async () => {
      const message = raw as WorkerJob;
      if (!message || (message.kind !== 'rerank' && message.kind !== 'embed')) return;
      const dirs = ((workerData ?? {}) as { modelDir?: string | null; embedModelDir?: string | null });
      try {
        if (message.kind === 'rerank') {
          if (!dirs.modelDir) throw new Error('retrieval worker started without modelDir');
          const scores = await scoreBatch(dirs.modelDir, message.query, message.candidates);
          port.postMessage({ kind: 'rerank:result', jobId: message.jobId, scores });
        } else {
          if (!dirs.embedModelDir) throw new Error('retrieval worker started without embedModelDir');
          const pipeline = await loadEmbed(dirs.embedModelDir);
          const output = await pipeline(message.texts, { pooling: 'cls', normalize: true });
          port.postMessage({ kind: 'embed:result', jobId: message.jobId, vectors: output.tolist() });
        }
      } catch (err) {
        port.postMessage({
          kind: message.kind === 'rerank' ? 'rerank:error' : 'embed:error',
          jobId: message.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}
