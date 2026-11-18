// #364 review B-F2 (implementation-side, NOT frozen): the REAL meter path
// through makeBackend - a scripted nonzero pre/post tokenMeter sequence,
// and the cancelled-query null/no-reuse invariant (a cancelled evaluation
// never reports, nor re-reports, a real prompt-token count).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';

const NLC = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  historyResets: [] as string[],
  // Failure switches so the production error and cleanup paths are reachable.
  fail: { sessionCtor: false, historySeed: false, reset: false },
  // #364: cumulative evaluated-input tokens on the fake sequence's tokenMeter
  // (each prompt consumes 41), so makeBackend's REAL delta path is exercised
  // through the production seam, not only via an injected backend double.
  inputTokens: 0,
}));
vi.mock('node-llama-cpp', () => {
  // Mirrors the real Gemma4ChatWrapper default (reasoning=true) so a missing
  // override shows up instead of passing silently.
  class Gemma4ChatWrapper {
    readonly reasoning: boolean;
    constructor(options?: { reasoning?: boolean }) {
      this.reasoning = options?.reasoning ?? true;
    }
  }
  class LlamaChatSession {
    constructor(options: Record<string, unknown>) {
      if (NLC.fail.sessionCtor) throw new Error('stub: LlamaChatSession constructor failed');
      NLC.sessions.push(options);
    }
    setChatHistory(): void {
      if (NLC.fail.historySeed) throw new Error('stub: setChatHistory failed');
      NLC.historyResets.push('seed');
    }
    resetChatHistory(): void {
      if (NLC.fail.reset) throw new Error('stub: resetChatHistory failed');
      NLC.historyResets.push('reset');
    }
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      // Resolves AFTER the engine's poll fires the abort (resolved-after-
      // cancellation: the exact path the #364 review F1 leak lives on).
      await new Promise((r) => setTimeout(r, 30));
      if (typeof options.onToken === 'function') {
        // The library batches generated tokens into arrays (LlamaChat.js:2619);
        // deliver batches so the answer-token counter is exercised for real.
        for (let i = 0; i < 4; i += 1) (options.onToken as (t: unknown[]) => void)([1, 2]);
      }
      // #364: charge the sequence meter like a real evaluation (input tokens
      // include chat-template control tokens — that delta is what #364 reports).
      NLC.inputTokens += 41;
      return 'ok';
    }
  }
  return {
    // #156: both desktop tiers are LFM. The mock reports gemma-4 metadata ONLY
    // for a file whose name says gemma-4, so the identity-gated wrapper pin
    // (issue #154) stays exercisable against an operator-supplied gemma file
    // while the shipped LFM fixtures resolve no wrapper.
    readGgufFileInfo: async (filePath: string) => ({
      metadata: /gemma[ _-]?4/i.test(path.basename(String(filePath)))
        ? { general: { architecture: 'gemma4', name: 'Gemma 4 E2B' } }
        : { general: { architecture: 'lfm2', name: 'LFM2.5 2.6B' } },
    }),
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({
          // #364: the production makeBackend reads sequence.tokenMeter
          // (LlamaContextSequence owns the meter — not the context).
          getSequence: () => ({
            tokenMeter: {
              getState: () => ({ usedInputTokens: NLC.inputTokens, usedOutputTokens: 0 }),
            },
          }),
          dispose: () => undefined,
        }),
        dispose: () => undefined,
      }),
    }),
    LlamaChatSession,
    Gemma4ChatWrapper,
  };
});


/** Capture console.info lines emitted by the inference path. */
function captureConsoleInfo(): { lines: string[]; calls: unknown[][]; restore: () => void } {
  const lines: string[] = [];
  const calls: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
    calls.push(args);
  };
  return {
    lines,
    calls,
    restore: (): void => {
      console.info = original;
    },
  };
}


const GB = 1024 ** 3;
let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't364-meter-cancel-'));
  NLC.prompts.length = 0;
  NLC.sessions.length = 0;
  NLC.historyResets.length = 0;
  NLC.fail.sessionCtor = false;
  NLC.fail.historySeed = false;
  NLC.fail.reset = false;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function modelFiles() {
  const quality = path.join(tmpDir, 'quality.gguf');
  fs.writeFileSync(quality, 'x');
  return { quality };
}

function captureBudgetPayload() {
  let payload;
  const original = console.info;
  console.info = (...args) => {
    if (String(args[0]) === '[RAG] token-budget') payload = args[1];
  };
  return { payload: () => payload, restore: () => { console.info = original; } };
}

describe('#364 meter arithmetic + cancelled-query null/no-reuse (real meter path)', () => {
  it('scripted nonzero pre/post sequence reports the delta through the production seam', async () => {
    NLC.inputTokens = 100; // pre-evaluation meter state
    const engine = new LlamaEngine({ profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });
    const cap = captureBudgetPayload();
    try {
      await engine.query('meter question', {});
    } finally {
      cap.restore();
    }
    // The mock charges +41 per prompt: 100 -> 141.
    expect(NLC.inputTokens).toBe(141);
    expect(cap.payload() && cap.payload().realPromptTokens).toBe(41);
  });

  it('a cancelled query reports null and never reuses the previous count', async () => {
    NLC.inputTokens = 0;
    const engine = new LlamaEngine({ profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });
    const cap = captureBudgetPayload();
    try {
      await engine.query('first ok', {});
      expect(cap.payload() && cap.payload().realPromptTokens).toBe(41);
      // The flag flips MID-EVALUATION (after generate entry, while the
      // prompt is in flight): the meter delta is computed, then the query
      // resolves cancelled — the exact path the #364 review F1 leak lived on.
      let flag = false;
      setTimeout(() => {
        flag = true;
      }, 5);
      const cancelled = await engine.query('second cancelled', {
        cancellationEvent: { isSet: () => flag },
      });
      expect(cancelled.cancelled).toBe(true);
      expect(cap.payload() && cap.payload().realPromptTokens).toBeNull();
    } finally {
      cap.restore();
    }
  });
});
