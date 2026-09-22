// Embedding via @huggingface/transformers (onnxruntime-node underneath),
// mirroring the production OnnxEmbedder usage pattern.
let extractorPromise: Promise<{
  (text: string | string[], opts: Record<string, unknown>): Promise<{ data: Float32Array; dims: number[] }>;
}> | null = null;

export async function ensureEmbedder(modelDir: string): Promise<void> {
  if (extractorPromise) {
    await extractorPromise;
    return;
  }
  extractorPromise = (async () => {
    const tf = await import('@huggingface/transformers');
    return (await tf.pipeline('feature-extraction', modelDir, { dtype: 'fp32' })) as never;
  })();
  await extractorPromise;
}

export async function embed(text: string, modelDir: string): Promise<Float32Array> {
  await ensureEmbedder(modelDir);
  const extractor = (await extractorPromise)!;
  const out = await extractor(text, { pooling: 'cls', normalize: true });
  return out.data;
}

export const EMBEDDING_DIMS = 384;
