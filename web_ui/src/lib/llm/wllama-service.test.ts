/**
 * Tests for WllamaService — the wllama (WASM/CPU) LLM engine.
 * The @wllama/wllama module is mocked so no real WASM/model is needed.
 *
 * Issue #156: the packaged model is LiquidAI LFM2-1.2B-RAG (text-only). The
 * Gemma-era mmproj/template-override surface is gone — see
 * __tests__/t156-browser-llm.test.ts for the swap-level pins.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Controllable mock of the Wllama class ------------------------------------
const loadModelFromUrl = vi.fn(async () => undefined);
const exit = vi.fn(async () => undefined);
const isModelLoaded = vi.fn(() => true);
const setCompat = vi.fn();

// createChatCompletion is overloaded: stream:true -> async iterable of chunks,
// otherwise -> a full response object.
const createChatCompletion = vi.fn(async (opts: { stream?: boolean }) => {
  if (opts.stream) {
    async function* gen() {
      for (const piece of ['Hello', ', ', 'world']) {
        yield { choices: [{ delta: { content: piece } }] };
      }
    }
    return gen();
  }
  return { choices: [{ message: { content: 'Hello, world' } }] };
});

const ctorSpy = vi.fn();

vi.mock('@wllama/wllama', () => ({
  Wllama: class {
    constructor(pathConfig: unknown, config: unknown) {
      ctorSpy(pathConfig, config);
    }
    loadModelFromUrl = loadModelFromUrl;
    createChatCompletion = createChatCompletion;
    exit = exit;
    isModelLoaded = isModelLoaded;
    setCompat = setCompat;
  },
  CacheManager: class {
    constructor() {}
  },
}));

describe('WllamaService', () => {
  let WllamaService: typeof import('./wllama-service').WllamaService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Model presence probe (HEAD) — default: the GGUF is packaged. The
    // hardened probe (src/lib/models/probe.ts) reads Content-Type to reject the
    // SPA-fallback HTML response, so the mock must supply a non-HTML type.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          headers: { get: () => 'application/octet-stream' },
        }) as unknown as Response
      )
    );
    WllamaService = (await import('./wllama-service')).WllamaService;
  });

  it('is not ready before initialize()', () => {
    expect(WllamaService.getInstance().isReady()).toBe(false);
  });

  it('reports the wasm inference backend', () => {
    expect(WllamaService.getInstance().getInferenceMode()).toBe('wasm');
  });

  it('initializes offline (allowOffline) and loads the packaged LFM2 GGUF', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();

    expect(svc.isReady()).toBe(true);
    // `default` must be the actual .wasm FILE (wllama uses it verbatim), not a dir.
    expect(ctorSpy).toHaveBeenCalledWith(
      { default: '/models/wllama/wasm/wllama.wasm' },
      expect.objectContaining({ allowOffline: true })
    );
    // Loaded the GGUF from the same-origin /models/llm path — ModelSource is
    // { url } ONLY (issue #156: no mmprojUrl, the model is text-only), and no
    // Gemma-era chat-template override is injected (LFM2's embedded template
    // is used as-is).
    expect(loadModelFromUrl).toHaveBeenCalledTimes(1);
    const [modelSource, loadParams] = loadModelFromUrl.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(modelSource).toEqual({ url: '/models/llm/lfm2-1.2b-rag/model.gguf' });
    expect(loadParams).toEqual(
      expect.objectContaining({ useCache: true })
    );
    expect(loadParams).not.toHaveProperty('chat_template');
    expect(loadParams).not.toHaveProperty('jinja');
  });

  it('points the offline compat runtime at LOCAL assets, not the CDN', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    // Must override wllama's default jsdelivr compat with packaged paths.
    expect(setCompat).toHaveBeenCalledWith({
      worker: '/models/wllama/compat/wllama.js',
      wasm: '/models/wllama/compat/wllama.wasm',
    });
  });

  it('fails fast with a clear message when the model is not packaged', async () => {
    // GGUF HEAD probe returns 404.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    const svc = WllamaService.getInstance();
    await expect(svc.initialize()).rejects.toThrow(/not packaged|PACKAGING/);
    expect(svc.isReady()).toBe(false);
    // Should not even attempt to load when assets are missing.
    expect(loadModelFromUrl).not.toHaveBeenCalled();
  });

  it('streams tokens from chat completion chunks', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();

    const tokens: string[] = [];
    for await (const t of svc.generate([{ role: 'user', content: 'hi' }], { maxTokens: 16 })) {
      tokens.push(t);
    }
    // 4.5 discipline: emission is batched to decided sentence boundaries, and
    // 'Hello, world' has no terminator, so the terminal flush emits it whole.
    // The joined stream is what the consumer renders — it must be lossless.
    expect(tokens.join('')).toBe('Hello, world');
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, max_tokens: 16 })
    );
  });

  it('passes system messages through unchanged (LFM2 embedded template)', async () => {
    // Issue #156: with the Gemma-era template override removed, there is no
    // system-message extraction/kwarg machinery — messages reach wllama in the
    // order and shape the caller sent them.
    const svc = WllamaService.getInstance();
    await svc.initialize();

    await svc.generateComplete([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    const lastCall = createChatCompletion.mock.calls.at(-1)?.[0] as {
      chat_template_kwargs?: unknown;
    };
    expect(lastCall.chat_template_kwargs).toBeUndefined();
  });

  it('generateComplete returns the full message content', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    const out = await svc.generateComplete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('Hello, world');
  });

  it('generate throws if not initialized', async () => {
    const svc = WllamaService.getInstance();
    await expect(svc.generate([{ role: 'user', content: 'hi' }]).next()).rejects.toThrow(
      'not initialized'
    );
  });

  it('maps temperature/topP to wllama sampling params (temp/top_p)', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    await svc.generateComplete([{ role: 'user', content: 'hi' }], {
      temperature: 0.3,
      topP: 0.9,
    });
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ temp: 0.3, top_p: 0.9 })
    );
  });

  it('Issue #40 RC2: forwards repeatPenalty/frequencyPenalty/presencePenalty as wllama penalty_* with full-context lookback', async () => {
    // Critical: wllama's chat path uses penalty_repeat/penalty_freq/penalty_present
    // (SamplingParams names), NOT repeat_penalty/frequency_penalty. Using the
    // wrong names silently no-ops the anti-repetition fix.
    const svc = WllamaService.getInstance();
    await svc.initialize();
    await svc.generateComplete([{ role: 'user', content: 'hi' }], {
      repeatPenalty: 1.1,
      frequencyPenalty: 0.3,
      presencePenalty: 0.0,
    });
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        penalty_repeat: 1.1,
        penalty_freq: 0.3,
        penalty_present: 0.0,
        penalty_last_n: -1,
      })
    );
  });

  it('Issue #40 RC2: omits penalty fields entirely when none are supplied (unchanged default behavior)', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    await svc.generateComplete([{ role: 'user', content: 'hi' }]);
    const call = (createChatCompletion.mock.calls.at(-1) as Record<string, unknown>[])[0];
    expect(call).not.toHaveProperty('penalty_repeat');
    expect(call).not.toHaveProperty('penalty_last_n');
  });

  it('Issue #40 RC2: streaming generate() also forwards penalty_* params', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    for await (const _ of svc.generate([{ role: 'user', content: 'hi' }], {
      repeatPenalty: 1.1,
    })) {
      // consume
    }
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ penalty_repeat: 1.1, penalty_last_n: -1 })
    );
  });

  it('dispose() exits wllama and resets readiness', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    svc.dispose();
    expect(exit).toHaveBeenCalled();
    expect(svc.isReady()).toBe(false);
  });

  it('surfaces a clear error when model load fails', async () => {
    loadModelFromUrl.mockRejectedValueOnce(new Error('gguf 404'));
    const svc = WllamaService.getInstance();
    await expect(svc.initialize()).rejects.toThrow('Failed to initialize wllama model');
    expect(svc.isReady()).toBe(false);
  });

  // PRR-004: InMemoryStorageBackend round-trip test — verifies write() drains
  // the stream into a Blob and read() returns it, proving the OPFS bypass works.
  it('InMemoryStorageBackend write/read round-trips a stream into a Blob', async () => {
    const { InMemoryStorageBackend } = await import('./wllama-service');
    const backend = new InMemoryStorageBackend();

    expect(backend.isSupported()).toBe(true);

    // Create a ReadableStream with known data.
    const data = new TextEncoder().encode('Hello, model weights!');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    await backend.write('test-key', stream);

    // getSize() reports the correct byte length (proves the stream was drained).
    expect(await backend.getSize('test-key')).toBe(data.byteLength);

    // read() returns a Blob (proves the data was stored).
    const blob = await backend.read('test-key');
    expect(blob).not.toBeNull();
    expect(blob!.size).toBe(data.byteLength);

    // read() on a missing key returns null.
    expect(await backend.read('nonexistent')).toBeNull();
    expect(await backend.getSize('nonexistent')).toBe(-1);

    // list() includes the entry.
    const entries = await backend.list();
    expect(entries.some((e: { key: string }) => e.key === 'test-key')).toBe(true);

    // delete() removes it.
    await backend.delete('test-key');
    expect(await backend.read('test-key')).toBeNull();
    expect(await backend.getSize('test-key')).toBe(-1);
  });

  // --- Issue #156 decline-filter application ---------------------------------
  //
  // The LFM 1.2B models append trained-in "did you (perhaps) forget to include/
  // attach the document?" sentences when declining a not-in-sources question.
  // WllamaService applies filterDeclineSentences (./decline-filter.ts, the
  // browser twin of desktop llama-engine.ts's filter) to the completion result:
  // the streaming path filters the ACCUMULATED text and only ever emits a
  // growing prefix (a sentence split across chunks is still caught); the
  // non-streaming path filters the final answer. Answerable text passes
  // through byte-identical.

  const DECLINE_ANSWER =
    'The provided context does not contain information regarding the maximum permitted annual leave carryover for contractors in the EU. Did you perhaps forget to include the document containing this information? Once you provide the relevant document, I will be able to accurately determine and share the answer.';
  const DECLINE_FILTERED =
    'The provided context does not contain information regarding the maximum permitted annual leave carryover for contractors in the EU. ';

  it('#156: generateComplete filters the decline artefact sentences', async () => {
    createChatCompletion.mockImplementationOnce(async () => ({
      choices: [{ message: { content: DECLINE_ANSWER } }],
    }));
    const svc = WllamaService.getInstance();
    await svc.initialize();
    const out = await svc.generateComplete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe(DECLINE_FILTERED);
  });

  it('#156: generateComplete leaves answerable answers byte-identical', async () => {
    const answerable = 'The expense portal closes on the 15th of each month.';
    createChatCompletion.mockImplementationOnce(async () => ({
      choices: [{ message: { content: answerable } }],
    }));
    const svc = WllamaService.getInstance();
    await svc.initialize();
    const out = await svc.generateComplete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe(answerable);
  });

  it('#156: streaming filters a decline sentence split across chunks', async () => {
    // The decline marker arrives in chunk 1, the artefact sentence in chunk 2
    // (itself internally batched by the runtime). The filter runs over the
    // ACCUMULATED text — not per-chunk — so the complete artefact sentence is
    // removed once its terminator lands. (Tradeoff, identical to the desktop
    // engine: emitted text only ever GROWS, so a fragment of the artefact
    // emitted before its sentence terminator cannot be retracted mid-stream.)
    createChatCompletion.mockImplementationOnce(async () => {
      async function* gen() {
        const pieces = [
          'The provided context does not contain information regarding X. ',
          'Did you perhaps forget to include ',
          'the document containing this information?',
        ];
        for (const piece of pieces) {
          yield { choices: [{ delta: { content: piece } }] };
        }
      }
      return gen();
    });
    const svc = WllamaService.getInstance();
    await svc.initialize();
    let joined = '';
    for await (const t of svc.generate([{ role: 'user', content: 'hi' }])) {
      joined += t;
    }
    // 4.5 review finding 1 (browser twin): the sentence-boundary emission
    // discipline REPLACED the emitted-only-grows tradeoff — the artefact
    // sentence is only emitted once decided (removed here), so no fragment
    // ever surfaces, and the joined stream is the filtered projection.
    expect(joined).not.toMatch(/did you perhaps forget/i);
    expect(joined).toBe('The provided context does not contain information regarding X. ');
  });

  it('#156 STREAMING DISCIPLINE (4.5): word-level chunks never surface an artefact word, never splice', async () => {
    const raw =
      'The provided context does not contain information regarding X. ' +
      'Did you perhaps forget to include the document containing this information? ' +
      'Once you provide the relevant document, I will be able to help.';
    createChatCompletion.mockImplementationOnce(async () => {
      async function* gen() {
        for (const word of raw.split(/(\s+)/)) {
          if (word.length > 0) yield { choices: [{ delta: { content: word } }] };
        }
      }
      return gen();
    });
    const svc = WllamaService.getInstance();
    await svc.initialize();
    let joined = '';
    for await (const t of svc.generate([{ role: 'user', content: 'hi' }])) {
      joined += t;
    }
    expect(joined).not.toContain('Did you');
    expect(joined).not.toContain('Once you provide');
    // Joined emissions == filter(full raw answer): no skipped words, no splice.
    expect(joined).toBe(
      'The provided context does not contain information regarding X. '
    );
  });

  it('#156: streaming fully suppresses a decline sentence that arrives within one chunk', async () => {
    createChatCompletion.mockImplementationOnce(async () => {
      async function* gen() {
        yield {
          choices: [
            {
              delta: {
                content:
                  'The provided context does not contain information regarding X. Did you perhaps forget to include the document containing this information?',
              },
            },
          ],
        };
      }
      return gen();
    });
    const svc = WllamaService.getInstance();
    await svc.initialize();
    let joined = '';
    for await (const t of svc.generate([{ role: 'user', content: 'hi' }])) {
      joined += t;
    }
    expect(joined).toBe('The provided context does not contain information regarding X. ');
  });

  it('#156: streaming leaves answerable text lossless (sentence-batch discipline, no loss)', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    const tokens: string[] = [];
    for await (const t of svc.generate([{ role: 'user', content: 'hi' }])) {
      tokens.push(t);
    }
    expect(tokens.join('')).toBe('Hello, world');
  });
});
