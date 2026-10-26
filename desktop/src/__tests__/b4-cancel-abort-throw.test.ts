// Issue #249 (AC4): the abort-throw contract at the engine boundary.
//
// node-llama-cpp 3.20.0 THROWS `signal.reason` when an abort lands before any
// response segment exists (node-llama-cpp 3.20.0: LlamaChat.js:1071-1072 and :2245-2247), and the engine's
// generate() catch used to re-throw unconditionally — a genuine user cancel
// surfaced as a rejected query instead of the cancelled contract. The fix
// maps the abort to `{ cancelled: true }` ONLY when it is THIS call's own
// abort: the cancellation flag is set, the call's signal has fired
// (`abort.signal.aborted` — closing the undefined-equals-undefined trap), and
// the thrown value IS this signal's reason object. Everything else propagates.
//
// Four rows (the frozen c8 driver runs the whole file and requires 4 passed):
//   1. positive  — the engine's own abort resolves cancelled:true;
//   2. negative  — a foreign abort with the flag UNSET still rejects;
//   3. negative  — a non-abort error with the flag SET still rejects;
//   4. negative  — a foreign AbortError-shaped object with the flag SET still
//                  rejects (identity-based mapping, not name-based).
// RED at base (the file is absent; post-fix all four rows pass).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';

const NLC = vi.hoisted(() => {
  const state: {
    prompts: Array<Record<string, unknown>>;
    // Per-row prompt script: what the mocked prompt does after entry.
    mode: 'resolve-ok' | 'abort-latched' | 'reject-foreign-abort' | 'reject-generic';
    // Resolved when the mocked prompt has been entered (query() reached the
    // library call) — the latch point that makes the flag transitions
    // genuinely mid-flight rather than pre-set.
    entered: Promise<void> | null;
    signalEntered: ((v: void) => void) | null;
    // Rows 3/4: the mock waits on this latch before throwing, so the test
    // can set the flag FIRST and the engine's catch deterministically
    // observes isSet() === true (no microtask-ordering dependence).
    proceed: Promise<void> | null;
    resolveProceed: ((v: void) => void) | null;
  } = {
    prompts: [],
    mode: 'resolve-ok',
    entered: null,
    signalEntered: null,
    proceed: null,
    resolveProceed: null,
  };
  return state;
});

vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    constructor(_options: Record<string, unknown>) {}
    setChatHistory(): void {}
    resetChatHistory(): void {}
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      // Emit a chunk so the engine's surface/accumulated state is exercised:
      // row 1's cancelled answer is the flushSurface projection of this text.
      if (typeof options.onTextChunk === 'function') {
        (options.onTextChunk as (c: string) => void)('Ok. ');
      }
      const signal = options.signal as AbortSignal | undefined;
      if (NLC.mode !== 'resolve-ok') {
        NLC.signalEntered?.();
        if (NLC.mode === 'reject-generic' || NLC.mode === 'reject-foreign-abort') {
          // Deterministic ordering: the flag is already set (the test set it
          // after `entered`) — wait for the test's go-ahead, then throw.
          await NLC.proceed;
        }
        if (NLC.mode === 'abort-latched') {
          // Reject with the EXACT AbortReason object of THIS call's signal
          // once the engine's own controller aborts it (identity mapping).
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject((signal as AbortSignal).reason));
          });
        }
        if (NLC.mode === 'reject-foreign-abort') {
          // A fresh AbortError-shaped object — NOT this call's signal.reason.
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (NLC.mode === 'reject-generic') {
          throw new Error('boom: non-abort failure');
        }
      }
      if (typeof options.onToken === 'function') {
        (options.onToken as (t: unknown[]) => void)([1, 2]);
      }
      return 'ok';
    }
  }
  return {
    readGgufFileInfo: async () => ({ metadata: { general: { architecture: 'lfm2', name: 'LFM2.5 2.6B' } } }),
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: () => undefined }),
        dispose: () => undefined,
      }),
      dispose: () => undefined,
    }),
    LlamaChatSession,
  };
});

const { LlamaEngine } = await import('../../main/backend/inference/llama-engine.js');

let tmpDir = '';
function modelFiles(): { quality: string; fast: string } {
  const quality = path.join(tmpDir, 'quality.gguf');
  const fast = path.join(tmpDir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast };
}

function newEngine(): InstanceType<typeof LlamaEngine> {
  return new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * 1024 ** 3,
    cpuCount: () => 8,
    models: modelFiles(),
  });
}

/** The engine only surfaces when a query arrives; enter it first. */
async function engineSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-cancel-abort-throw-'));
  NLC.prompts.length = 0;
  NLC.mode = 'resolve-ok';
  NLC.entered = null;
  NLC.signalEntered = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('b4-cancel-abort-throw: the engine maps only its OWN abort to the cancelled contract (issue #249 AC9)', () => {
  it('row 1 (positive): own abort (flag set + signal aborted + exact reason) resolves cancelled:true', async () => {
    NLC.mode = 'abort-latched';
    NLC.entered = new Promise<void>((resolve) => {
      NLC.signalEntered = resolve;
    });
    const engine = newEngine();
    const flag = { set: false, isSet: () => flag.set };
    const promise = engine.query('answer me', { cancellationEvent: flag });
    await NLC.entered;
    await engineSettled();
    expect(NLC.prompts).toHaveLength(1);
    // Set the flag only AFTER query entry: the pre-flight early return must
    // not be what resolves this row.
    flag.set = true;
    const result = await promise;
    expect(result.cancelled).toBe(true);
    // flushSurface ran: the streamed chunk ('Ok. ') is projected into the
    // cancelled answer through filterDeclineSentences.
    expect(result.answer).toContain('Ok.');
    expect(NLC.prompts).toHaveLength(1);
  });

  it('row 2 (negative): a foreign abort with the flag UNSET still rejects', async () => {
    NLC.mode = 'reject-foreign-abort';
    NLC.entered = new Promise<void>((resolve) => {
      NLC.signalEntered = resolve;
    });
    const engine = newEngine();
    const promise = engine.query('answer me', {});
    await NLC.entered;
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(NLC.prompts).toHaveLength(1);
  });

  it('row 3 (negative): a non-abort error with the flag SET still rejects', async () => {
    NLC.mode = 'reject-generic';
    NLC.entered = new Promise<void>((resolve) => {
      NLC.signalEntered = resolve;
    });
    const engine = newEngine();
    const flag = { set: false, isSet: () => flag.set };
    const promise = engine.query('answer me', { cancellationEvent: flag });
    await NLC.entered;
    flag.set = true;
    NLC.resolveProceed?.();
    await expect(promise).rejects.toThrow('boom: non-abort failure');
    expect(NLC.prompts).toHaveLength(1);
  });

  it('row 4 (negative): a FOREIGN AbortError-shaped object with the flag SET still rejects (identity, not name)', async () => {
    NLC.mode = 'reject-foreign-abort';
    NLC.entered = new Promise<void>((resolve) => {
      NLC.signalEntered = resolve;
    });
    const engine = newEngine();
    const flag = { set: false, isSet: () => flag.set };
    const promise = engine.query('answer me', { cancellationEvent: flag });
    await NLC.entered;
    flag.set = true;
    NLC.resolveProceed?.();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(NLC.prompts).toHaveLength(1);
  });
});
