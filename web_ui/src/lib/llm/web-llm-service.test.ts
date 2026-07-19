/**
 * WebLLM Service tests
 *
 * Tests are structured to avoid cross-test contamination from mocks.
 * Each test that modifies global state (navigator.gpu) properly restores it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mock @mlc-ai/web-llm — must be declared before any imports that use it
// -------------------------------------------------------------------------
const mockCreateMLCEngine = vi.fn();

vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: mockCreateMLCEngine,
  prebuiltAppConfig: { model_list: [] },
}));

// -------------------------------------------------------------------------
// Mock navigator.gpu — defined before importing the service
// -------------------------------------------------------------------------
const mockGpuAdapter = {
  requestDevice: vi.fn().mockResolvedValue({}),
};
const mockNvgpu = {
  requestAdapter: vi.fn().mockResolvedValue(mockGpuAdapter),
};

// Store original gpu before any tests run
const originalGpu = (global.navigator as unknown as Record<string, unknown>).gpu;

Object.defineProperty(global, 'navigator', {
  value: { gpu: mockNvgpu },
  writable: true,
  configurable: true,
});

// -------------------------------------------------------------------------
// Import the service under test AFTER mocks are set up
// -------------------------------------------------------------------------
import { WebLLMService } from './web-llm-service';
import type { LLMMessage } from '@/types/llm';

// -------------------------------------------------------------------------
// Re-export mock for use in tests
// -------------------------------------------------------------------------
export { mockCreateMLCEngine, mockNvgpu, mockGpuAdapter };

// Helper to create a valid mock engine with all required methods
function createMockEngine(overrides = {}) {
  return {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
    interruptGenerate: vi.fn(),
    unload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('WebLLMService', () => {
  beforeEach(() => {
    // Clear mock calls
    mockCreateMLCEngine.mockClear();
    mockNvgpu.requestAdapter.mockClear();

    // Reset to default: WebGPU available
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    // Reset singleton state
    WebLLMService.getInstance().dispose();
  });

  // -------------------------------------------------------------------------
  // Singleton pattern
  // -------------------------------------------------------------------------
  test('getInstance returns the same instance (singleton)', () => {
    const instance1 = WebLLMService.getInstance();
    const instance2 = WebLLMService.getInstance();
    expect(instance1).toBe(instance2);
  });

  // -------------------------------------------------------------------------
  // initialize with WebGPU available
  // -------------------------------------------------------------------------
  test('initialize succeeds when WebGPU is available', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    expect(service.isReady()).toBe(true);
    expect(service.getInferenceMode()).toBe('webgpu');
  });

  test('initialize records modelInfo after successful load', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('Llama-3.2-3B-Instruct-q4f16_1-MLC');

    const modelInfo = service.getModelInfo();
    expect(modelInfo).not.toBeNull();
    expect(modelInfo!.modelId).toBe('Llama-3.2-3B-Instruct-q4f16_1-MLC');
    expect(modelInfo!.quantization).toBe('q4f16_1');
  });

  test('initialize uses the provided modelId', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('Llama-3.2-3B-Instruct-q4f16_1-MLC');

    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      'Llama-3.2-3B-Instruct-q4f16_1-MLC',
      expect.objectContaining({ initProgressCallback: expect.any(Function) })
    );
  });

  test('initialize throws when modelId is not in allowlist', async () => {
    const service = WebLLMService.getInstance();
    await expect(service.initialize('Unknown-Model')).rejects.toThrow(
      'Unknown modelId'
    );
    expect(service.isReady()).toBe(false);
  });

  test('initialize accepts Llama-3.2-3B-Instruct-q4f16_1-MLC', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('Llama-3.2-3B-Instruct-q4f16_1-MLC');

    expect(service.isReady()).toBe(true);
    expect(mockCreateMLCEngine).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // initialize fails fast when WebGPU unavailable
  // -------------------------------------------------------------------------
  test('initialize throws when WebGPU is not available (navigator.gpu missing)', async () => {
    // Remove gpu temporarily
    const originalDescriptor = Object.getOwnPropertyDescriptor(global.navigator, 'gpu');
    delete (global.navigator as unknown as Record<string, unknown>).gpu;

    try {
      const service = WebLLMService.getInstance();
      await expect(service.initialize()).rejects.toThrow(
        'WebGPU is not available in this browser'
      );
      expect(service.isReady()).toBe(false);
    } finally {
      // Restore gpu
      if (originalDescriptor) {
        Object.defineProperty(global.navigator, 'gpu', originalDescriptor);
      }
    }
  });

  test('initialize throws when requestAdapter returns null', async () => {
    mockNvgpu.requestAdapter.mockResolvedValueOnce(null);

    const service = WebLLMService.getInstance();
    await expect(service.initialize()).rejects.toThrow(
      'WebGPU is not available in this browser'
    );
    expect(service.isReady()).toBe(false);
  });

  test('initialize throws when WebGPU adapter request throws', async () => {
    mockNvgpu.requestAdapter.mockRejectedValueOnce(new Error('GPU error'));

    const service = WebLLMService.getInstance();
    await expect(service.initialize()).rejects.toThrow(
      'WebGPU is not available in this browser'
    );
  });

  test('initialize is idempotent when already ready', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();
    const callCount = mockCreateMLCEngine.mock.calls.length;

    // Second call should be no-op
    await service.initialize();
    expect(mockCreateMLCEngine.mock.calls.length).toBe(callCount);
    expect(service.isReady()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // generate streams tokens via AsyncGenerator
  // -------------------------------------------------------------------------
  test('generate yields streaming tokens', async () => {
    const mockChunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: { content: '!' } }] },
    ];

    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of mockChunks) {
          yield chunk;
        }
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const messages: LLMMessage[] = [
      { role: 'user', content: 'Say hello' },
    ];

    const tokens: string[] = [];
    for await (const token of service.generate(messages)) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['Hello', ' ', 'world', '!']);
  });

  test('generate throws when not initialized', async () => {
    const service = WebLLMService.getInstance();
    service.dispose();

    const messages: LLMMessage[] = [{ role: 'user', content: 'test' }];

    await expect(
      (async () => {
        for await (const _ of service.generate(messages)) {
          // consume
        }
      })()
    ).rejects.toThrow('WebLLMService not initialized');
  });

  // -------------------------------------------------------------------------
  // generateComplete returns full string
  // -------------------------------------------------------------------------
  test('generateComplete returns full non-streaming response', async () => {
    const mockResponse = {
      choices: [{ message: { content: 'This is the complete response' } }],
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const messages: LLMMessage[] = [{ role: 'user', content: 'Give me a response' }];
    const result = await service.generateComplete(messages);

    expect(result).toBe('This is the complete response');
    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: false })
    );
  });

  test('generateComplete throws when not initialized', async () => {
    const service = WebLLMService.getInstance();
    service.dispose();

    await expect(
      service.generateComplete([{ role: 'user', content: 'test' }])
    ).rejects.toThrow('WebLLMService not initialized');
  });

  test('generateComplete returns empty string when no content', async () => {
    const mockResponse = {
      choices: [{ message: { content: undefined } }],
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const result = await service.generateComplete([{ role: 'user', content: 'test' }]);
    expect(result).toBe('');
  });

  // -------------------------------------------------------------------------
  // generate forwards options (max_tokens, temperature, top_p)
  // -------------------------------------------------------------------------
  test('generate forwards maxTokens, temperature, topP to completions.create', async () => {
    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'hi' } }] };
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }];
    // generate() is an async generator — its body (and the completions.create
    // call) only runs when iterated. Drain it so the options are forwarded.
    for await (const _ of service.generate(messages, {
      maxTokens: 100,
      temperature: 0.7,
      topP: 0.9,
    })) {
      void _;
    }

    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 100,
        temperature: 0.7,
        top_p: 0.9,
      })
    );
  });

  test('generateComplete forwards maxTokens, temperature, topP to completions.create', async () => {
    const mockResponse = {
      choices: [{ message: { content: 'response' } }],
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    await service.generateComplete([{ role: 'user', content: 'hi' }], {
      maxTokens: 50,
      temperature: 0.5,
      topP: 0.8,
    });

    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 50,
        temperature: 0.5,
        top_p: 0.8,
        stream: false,
      })
    );
  });

  test('Issue #40 RC2: forwards frequencyPenalty/presencePenalty as OpenAI-style penalties (no repeat_penalty — WebLLM lacks it)', async () => {
    const mockResponse = {
      choices: [{ message: { content: 'response' } }],
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    await service.generateComplete([{ role: 'user', content: 'hi' }], {
      frequencyPenalty: 0.3,
      presencePenalty: 0.2,
      repeatPenalty: 1.1, // WebLLM has no repeat_penalty equivalent — must be dropped.
    });

    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
      })
    );
    // WebLLM (MLC) has NO repeat_penalty — confirm it is not forwarded.
    const call = mockEngine.chat.completions.create.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('repeat_penalty');
    expect(call).not.toHaveProperty('penalty_repeat');
  });

  // -------------------------------------------------------------------------
  // interrupt() calls engine.interruptGenerate()
  // -------------------------------------------------------------------------
  test('interrupt calls engine.interruptGenerate()', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    service.interrupt();

    expect(mockEngine.interruptGenerate).toHaveBeenCalledTimes(1);
  });

  test('interrupt is safe when engine is null', () => {
    const service = WebLLMService.getInstance();
    service.dispose();

    expect(() => service.interrupt()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // S7 (issue #36): generate() wires an abort listener that calls
  // engine.interruptGenerate() and removes it on settle (no listener leak).
  // -------------------------------------------------------------------------
  test('generate calls engine.interruptGenerate() when the abort signal fires (S7)', async () => {
    // The completion iterator stays open until interruptGenerate() ends it;
    // we release it only after the abort fires so the test reaches the
    // abort-listener path deterministically.
    let releaseIterator: () => void = () => {};
    const iteratorDone = new Promise<void>((resolve) => {
      releaseIterator = resolve;
    });
    let firstTokenDelivered: () => void = () => {};
    const firstTokenSeen = new Promise<void>((resolve) => {
      firstTokenDelivered = resolve;
    });
    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        await iteratorDone;
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const controller = new AbortController();
    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }];

    // Drive the generator. The first chunk yields; then we abort, which must
    // trigger engine.interruptGenerate() via the abort listener.
    const collected: string[] = [];
    const generation = (async () => {
      for await (const tok of service.generate(messages, { signal: controller.signal })) {
        collected.push(tok);
        firstTokenDelivered();
      }
    })();

    // Wait until the first token is actually delivered to the consumer so we
    // know the generator body has run and the abort listener is registered.
    await firstTokenSeen;
    expect(mockEngine.interruptGenerate).not.toHaveBeenCalled();

    controller.abort();
    releaseIterator();

    await generation;

    expect(mockEngine.interruptGenerate).toHaveBeenCalledTimes(1);
    expect(collected).toEqual(['partial']);
  });

  test('generate removes its abort listener after settling — no leak (S7)', async () => {
    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'hi' } }] };
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    // Drain the generator to completion so the finally block runs.
    for await (const _ of service.generate([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })) {
      void _;
    }

    // The abort listener registered in generate() must be removed in the
    // finally block so repeated generations don't accumulate stale listeners
    // on long-lived AbortSignals/AbortControllers.
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeEventListenerSpy.mockRestore();
  });

  test('generate calls interruptGenerate() up front if the signal is already aborted (S7)', async () => {
    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'hi' } }] };
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const controller = new AbortController();
    controller.abort();

    for await (const _ of service.generate([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })) {
      void _;
    }

    // When the signal is already aborted at entry, generate() invokes
    // interruptGenerate() immediately (mirrors the addEventListener path).
    expect(mockEngine.interruptGenerate).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // dispose() calls engine.unload()
  // -------------------------------------------------------------------------
  test('dispose calls engine.unload() when available', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();
    expect(service.isReady()).toBe(true);

    service.dispose();

    expect(mockEngine.unload).toHaveBeenCalledTimes(1);
    expect(service.isReady()).toBe(false);
  });

  test('dispose resets _engine, _modelInfo, and _ready', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();
    expect(service.getModelInfo()).not.toBeNull();

    service.dispose();

    expect(service.getModelInfo()).toBeNull();
    expect(service.isReady()).toBe(false);
  });

  test('dispose is safe when engine.unload is undefined', async () => {
    const mockEngine = {
      chat: { completions: { create: vi.fn() } },
      interruptGenerate: vi.fn(),
      // unload intentionally omitted
    };

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    expect(() => service.dispose()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // isReady state transitions
  // -------------------------------------------------------------------------
  test('isReady is false before initialization', () => {
    const service = WebLLMService.getInstance();
    service.dispose();
    expect(service.isReady()).toBe(false);
  });

  test('isReady is true after successful initialize', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    expect(service.isReady()).toBe(false);

    await service.initialize();
    expect(service.isReady()).toBe(true);
  });

  test('isReady is false after dispose', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();
    expect(service.isReady()).toBe(true);

    service.dispose();
    expect(service.isReady()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getModelInfo after init
  // -------------------------------------------------------------------------
  test('getModelInfo returns null before initialization', () => {
    const service = WebLLMService.getInstance();
    service.dispose();
    expect(service.getModelInfo()).toBeNull();
  });

  test('getModelInfo returns correct quantization for Q4 model', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('Llama-3.2-3B-Instruct-q4f16_1-MLC');

    const info = service.getModelInfo();
    expect(info!.quantization).toBe('q4f16_1');
  });

  test.skip('getModelInfo returns unknown quantization for non-Q4 model (skipped: allowlist prevents testing non-allowlisted modelIds)', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('MyModel-F16');

    const info = service.getModelInfo();
    expect(info!.quantization).toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // getInferenceMode
  // -------------------------------------------------------------------------
  test('getInferenceMode returns webgpu after init', async () => {
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    expect(service.getInferenceMode()).toBe('webgpu');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  test('generate maps LLMMessage roles correctly to API format', async () => {
    const mockCompletion = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'response' } }] };
      },
    };

    const mockEngine = createMockEngine({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockCompletion),
        },
      },
    });

    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize();

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    // generate() is an async generator — drain it so the body runs and the
    // messages are mapped and forwarded to completions.create.
    for await (const _ of service.generate(messages)) {
      void _;
    }

    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      })
    );
  });

  test('initialize handles storage quota error with friendly message', async () => {
    // WebGPU must be available first
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    const quotaError = new Error('QuotaExceededError: Storage quota exceeded');
    mockCreateMLCEngine.mockRejectedValue(quotaError);

    const service = WebLLMService.getInstance();
    await expect(service.initialize()).rejects.toThrow('storage quota exceeded');
  });
});
