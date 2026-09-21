// Quality-profile LLM loading + streaming generation via node-llama-cpp.
// Mirrors the production LlamaEngine patterns (dynamic import, abort signal
// with stopOnAbortSignal) without importing desktop/ code.
export interface StreamOutcome {
  tokens: number;
  firstTokenMs: number | null;
  cancelled: boolean;
  text: string;
}

type LlamaBackend = {
  ctx: unknown;
  model: unknown;
  session: {
    prompt(prompt: string, opts: Record<string, unknown>): Promise<string>;
    dispose?: () => void;
  };
};

let backendPromise: Promise<LlamaBackend> | null = null;

type LogFn = (line: string) => void;
let log: LogFn = () => {};
export function setLlmLogger(fn: LogFn): void {
  log = fn;
}

export async function ensureLlm(ggufPath: string, threads: number): Promise<LlamaBackend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    // node-llama-cpp is ESM-only; under a CJS build TS transpiles import() to
    // require(), which cannot load an ESM graph - route through a real import.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<typeof import('node-llama-cpp')>;
    const nlc = await dynamicImport('node-llama-cpp');
    const llama = await nlc.getLlama({ build: 'never' });
    log(`[llm] llama ready; loadModel begin`);
    const model = await llama.loadModel({ modelPath: ggufPath });
    log(`[llm] model loaded; createContext begin`);
    const ctx = await model.createContext({ threads });
    log(`[llm] context ready`);
    const session = new nlc.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      autoDisposeSequence: false,
    });
    return { ctx, model, session };
  })();
  return backendPromise;
}

export async function streamGenerate(
  ggufPath: string,
  threads: number,
  prompt: string,
  onToken: (t: string) => void,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  const backend = await ensureLlm(ggufPath, threads);
  const started = Date.now();
  const outcome: StreamOutcome = { tokens: 0, firstTokenMs: null, cancelled: false, text: '' };
  try {
    await backend.session.prompt(prompt, {
      onTextChunk(chunk: string) {
        if (outcome.firstTokenMs === null) outcome.firstTokenMs = Date.now() - started;
        outcome.tokens += 1;
        outcome.text += chunk;
        onToken(chunk);
      },
      signal,
      stopOnAbortSignal: true,
      maxTokens: 512,
    });
  } catch (err) {
    if (signal.aborted) {
      outcome.cancelled = true;
    } else {
      throw err;
    }
  }
  if (signal.aborted) outcome.cancelled = true;
  // True generated-token count from the model tokenizer (chunks != tokens).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = backend.model as { tokenize?: (t: string) => number[] };
    if (typeof model?.tokenize === 'function') {
      outcome.tokens = model.tokenize(outcome.text).length;
    }
  } catch {
    /* chunk count remains the fallback */
  }
  return outcome;
}

export function llmStatus(ggufPath: string): { staged: boolean; path: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  return { staged: fs.existsSync(ggufPath), path: ggufPath };
}
