/**
 * Tests for WllamaService — the wllama (WASM/CPU) LLM engine.
 * The @wllama/wllama module is mocked so no real WASM/model is needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Controllable mock of the Wllama class ------------------------------------
const loadModelFromUrl = vi.fn(async () => undefined);
const exit = vi.fn(async () => undefined);
const isModelLoaded = vi.fn(() => true);
const supportInputModality = vi.fn(() => true);
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
    supportInputModality = supportInputModality;
    setCompat = setCompat;
  },
}));

describe('WllamaService', () => {
  let WllamaService: typeof import('./wllama-service').WllamaService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Model presence probe (HEAD) — default: GGUF + mmproj are packaged.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
    WllamaService = (await import('./wllama-service')).WllamaService;
  });

  it('is not ready before initialize()', () => {
    expect(WllamaService.getInstance().isReady()).toBe(false);
  });

  it('reports the wasm inference backend', () => {
    expect(WllamaService.getInstance().getInferenceMode()).toBe('wasm');
  });

  it('initializes offline (allowOffline) and loads the model + mmproj', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();

    expect(svc.isReady()).toBe(true);
    // `default` must be the actual .wasm FILE (wllama uses it verbatim), not a dir.
    expect(ctorSpy).toHaveBeenCalledWith(
      { default: '/models/wllama/wasm/wllama.wasm' },
      expect.objectContaining({ allowOffline: true })
    );
    // Loaded GGUF + mmproj from same-origin /models/llm paths.
    expect(loadModelFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/models/llm/lfm2-vl-1.6b/model.gguf',
        mmprojUrl: '/models/llm/lfm2-vl-1.6b/mmproj.gguf',
      }),
      expect.objectContaining({ useCache: true })
    );
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
    // GGUF/mmproj HEAD probes return 404.
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
    expect(tokens).toEqual(['Hello', ', ', 'world']);
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, max_tokens: 16 })
    );
  });

  it('passes multimodal (text + image) content through to wllama', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();

    const imgData = new ArrayBuffer(16);
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'What is in this image?' },
          { type: 'image' as const, data: imgData },
        ],
      },
    ];
    // Drain the stream.
    for await (const _ of svc.generate(messages)) { /* consume */ }

    const passed = createChatCompletion.mock.calls.at(-1)?.[0];
    expect(passed.messages[0].content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: imgData },
    ]);
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

  it('supportsImages reflects the model modality', async () => {
    const svc = WllamaService.getInstance();
    await svc.initialize();
    expect(svc.supportsImages()).toBe(true);
    supportInputModality.mockReturnValueOnce(false);
    expect(svc.supportsImages()).toBe(false);
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
});
