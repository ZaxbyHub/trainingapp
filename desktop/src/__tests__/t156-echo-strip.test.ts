// t156-echo-strip.test.ts — issue #156 (frozen check C3 runs this suite).
//
// AC3: when a tier sets reasoningPolicy.responsePrefix, node-llama-cpp ECHOES
// the prefill back as the first response chunk(s) — a mechanical artefact, not
// generated output. The engine must strip that echo from BOTH the
// onTextChunk stream the caller sees AND the final answer, so neither ever
// contains the literal '</think>' marker (the leak was 02-reproduction.md R4).
// Also pins that the prompt options carry responsePrefix+budgets for quality
// and NEITHER for fast, and that generation params carry no repeatPenalty
// (penalty wiring retired per plan section 1).
//
// Seam: the production defaultLlamaFactory driven against a mocked
// node-llama-cpp (the settings-wiring-honesty pattern). The fake session's
// prompt() replays a per-test chunk script through options.onTextChunk and
// returns a per-test raw answer — exactly the calling convention the real
// library uses with responsePrefix set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';

const NLC = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
  /** Chunks the fake session streams, and the raw answer it returns. */
  script: [] as string[],
  answer: '',
}));
vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    constructor(_options: Record<string, unknown>) {
      // not this suite's subject
    }
    setChatHistory(): void {}
    resetChatHistory(): void {}
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      const chunks = options.onTextChunk as ((chunk: string) => void) | undefined;
      for (const chunk of NLC.script) chunks?.(chunk);
      return NLC.answer;
    }
  }
  return {
    readGgufFileInfo: async () => ({
      metadata: { general: { architecture: 'lfm2', name: 'LFM2.5 2.6B' } },
    }),
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: () => undefined }),
        dispose: () => undefined,
      }),
    }),
    LlamaChatSession,
  };
});

const GB = 1024 ** 3;
let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't156-echo-strip-'));
  NLC.prompts.length = 0;
  NLC.script = [];
  NLC.answer = '';
});

function makeEngine(profile: 'quality' | 'fast'): LlamaEngine {
  const quality = path.join(tmpDir, 'quality.gguf');
  const fast = path.join(tmpDir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return new LlamaEngine({
    profile,
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality, fast },
  });
}

describe('#156 echo strip: the responsePrefix prefill never reaches the caller', () => {
  it('quality: chunks carrying the echoed prefix are sliced so stream AND answer contain no </think>', async () => {
    // The prefix is 11 chars ('\n' + '</think>' + '\n\n'); split it across the
    // first TWO chunks so the strip must carry state across chunk boundaries,
    // then stream plain answer text.
    NLC.script = ['\n</th', 'ink>\n\nThe annual', ' leave policy is 42 days.'];
    NLC.answer = '\n</think>\n\nThe annual leave policy is 42 days.';
    const streamed: string[] = [];
    const result = await makeEngine('quality').query('how many days?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    for (const chunk of streamed) {
      expect(chunk, `stream chunk ${JSON.stringify(chunk)} must not carry the think marker`).not.toContain('</think>');
    }
    expect(streamed.join('')).toBe('The annual leave policy is 42 days.');
    expect(result.answer).toBe('The annual leave policy is 42 days.');
    expect(result.answer).not.toContain('</think>');
  });

  it('quality: a prefix-sized first chunk is swallowed entirely (nothing emitted for it)', async () => {
    // First chunk is EXACTLY the prefix: the surface() echo counter consumes
    // it whole, so the caller's first emission starts with the answer text.
    NLC.script = ['\n</think>\n\n', 'Paris.'];
    NLC.answer = '\n</think>\n\nParis.';
    const streamed: string[] = [];
    const result = await makeEngine('quality').query('capital of France?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    expect(streamed).toEqual(['Paris.']);
    expect(result.answer).toBe('Paris.');
  });

  it('fast: no prefix is echoed, streamed or sliced — the stream is the answer verbatim', async () => {
    NLC.script = ['Fast answer ', 'here.'];
    NLC.answer = 'Fast answer here.';
    const streamed: string[] = [];
    const result = await makeEngine('fast').query('q', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    expect(streamed.join('')).toBe('Fast answer here.');
    expect(result.answer).toBe('Fast answer here.');
  });
});

describe('#156 the reasoning policy rides the prompt options per tier', () => {
  it('quality prompts carry responsePrefix + zero thought budget', async () => {
    NLC.script = ['\n</think>\n\nok'];
    NLC.answer = '\n</think>\n\nok';
    await makeEngine('quality').query('q', {});
    expect(NLC.prompts).toHaveLength(1);
    expect(NLC.prompts[0]).toMatchObject({
      responsePrefix: '\n</think>\n\n',
      budgets: { thoughtTokens: 0 },
    });
  });

  it('fast prompts carry NEITHER responsePrefix NOR budgets (the key is absent, not null)', async () => {
    NLC.script = ['ok'];
    NLC.answer = 'ok';
    await makeEngine('fast').query('q', {});
    expect(NLC.prompts).toHaveLength(1);
    // `in` rejects a present-but-undefined key as well as an explicit null.
    expect('responsePrefix' in NLC.prompts[0]).toBe(false);
    expect('budgets' in NLC.prompts[0]).toBe(false);
  });
});

describe('#156 the retired penalty wiring: no repeatPenalty on either tier', () => {
  it('prompt generation params for BOTH tiers carry no repeatPenalty', async () => {
    NLC.script = ['ok'];
    NLC.answer = 'ok';
    await makeEngine('quality').query('q', {});
    NLC.script = ['ok'];
    await makeEngine('fast').query('q', {});
    expect(NLC.prompts).toHaveLength(2);
    for (const [index, prompt] of NLC.prompts.entries()) {
      expect(prompt, `prompt #${index} must carry no penalty keys`).not.toHaveProperty('repeatPenalty');
      expect(prompt).not.toHaveProperty('penalty');
      expect(prompt).not.toHaveProperty('frequencyPenalty');
      expect(prompt).not.toHaveProperty('presencePenalty');
    }
  });
});
