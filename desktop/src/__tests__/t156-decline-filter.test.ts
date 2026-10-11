// t156-decline-filter.test.ts — issue #156 (frozen check C4 runs this suite).
//
// Pins the decline-sentence filter (approved plan section 3): the trained-in
// "did you perhaps forget to include the document?" artefact sentences the LFM
// 1.2B models append to declines — including the captured variant from
// 02-reproduction.md R6 that the first probe regex missed — are stripped from
// the final answer AND the streamed chunks (tested through the real
// LlamaEngine generate seam, not just as a free function), while answerable
// answers pass through byte-identical (marker-scoped: no false positives).
//
// The fixture set lives in ./fixtures/decline-fixtures.ts — ONE fixture source
// shared with the web_ui browser-path filter (plan section 4b).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filterDeclineSentences } from '../../main/backend/inference/decline-filter.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import {
  ANSWERABLE_ANSWER,
  ANSWERABLE_MENTIONS_DOCUMENTS,
  CAPTURED_DECLINE,
  CAPTURED_DECLINE_FILTERED,
  DECLINE_PLEASE_PROVIDE,
  DECLINE_PLEASE_PROVIDE_FILTERED,
  DECLINE_WITHOUT_PERHAPS,
  DECLINE_WITHOUT_PERHAPS_FILTERED,
} from './fixtures/decline-fixtures.js';

// The generate()-level block drives the production defaultLlamaFactory against
// a mocked node-llama-cpp (the settings-wiring-honesty seam), so the filter is
// exercised where it is wired: on the accumulated stream and on the answer.
const NLC = vi.hoisted(() => ({
  script: [] as string[],
  answer: '',
}));
vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    constructor(_options: Record<string, unknown>) {}
    setChatHistory(): void {}
    resetChatHistory(): void {}
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      const chunks = options.onTextChunk as ((chunk: string) => void) | undefined;
      for (const chunk of NLC.script) chunks?.(chunk);
      return NLC.answer;
    }
  }
  return {
    readGgufFileInfo: async () => ({
      metadata: { general: { architecture: 'lfm2', name: 'LFM2-1.2B-RAG' } },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't156-decline-'));
  NLC.script = [];
  NLC.answer = '';
});

function makeFastEngine(): LlamaEngine {
  const quality = path.join(tmpDir, 'quality.gguf');
  const fast = path.join(tmpDir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality, fast },
  });
}

describe('#156 filterDeclineSentences: the captured decline and its variants', () => {
  it('the captured production decline: both artefact sentences removed, decline statement kept', () => {
    expect(filterDeclineSentences(CAPTURED_DECLINE)).toBe(CAPTURED_DECLINE_FILTERED);
    const out = filterDeclineSentences(CAPTURED_DECLINE);
    expect(out).not.toContain('Did you');
    expect(out).not.toContain('Once you provide');
    expect(out).toContain('does not contain information regarding');
  });

  it('the variant without "perhaps" is caught too (the first probe regex missed it, R6)', () => {
    expect(filterDeclineSentences(DECLINE_WITHOUT_PERHAPS)).toBe(DECLINE_WITHOUT_PERHAPS_FILTERED);
  });

  it('the "Please provide the relevant document..." family is removed', () => {
    expect(filterDeclineSentences(DECLINE_PLEASE_PROVIDE)).toBe(DECLINE_PLEASE_PROVIDE_FILTERED);
  });

  it('a marker-bearing decline WITHOUT artefact sentences is byte-identical (the filter never invents edits)', () => {
    const cleanDecline = 'The provided context does not contain information about the requested topic.';
    expect(filterDeclineSentences(cleanDecline)).toBe(cleanDecline);
  });
});

describe('#156 filterDeclineSentences: answerable answers are untouched', () => {
  it('an answerable answer passes through byte-identical', () => {
    expect(filterDeclineSentences(ANSWERABLE_ANSWER)).toBe(ANSWERABLE_ANSWER);
  });

  it('an answerable answer that MENTIONS documents still passes through (no marker, no edit)', () => {
    expect(filterDeclineSentences(ANSWERABLE_MENTIONS_DOCUMENTS)).toBe(ANSWERABLE_MENTIONS_DOCUMENTS);
  });

  it('the empty string is a byte-identical passthrough', () => {
    expect(filterDeclineSentences('')).toBe('');
  });
});

describe('#156 generate() wiring: streamed declines never surface the artefact', () => {
  it('a streamed decline (marker first, artefact in a later chunk) hides the artefact from the stream AND the answer', async () => {
    // Split exactly where production splits: the marker sentence streams
    // first, the artefact sentences arrive in the next chunk — so the filter
    // must work on the ACCUMULATED text, not per chunk.
    NLC.script = [CAPTURED_DECLINE_FILTERED, CAPTURED_DECLINE.slice(CAPTURED_DECLINE_FILTERED.length)];
    NLC.answer = CAPTURED_DECLINE;
    const streamed: string[] = [];
    const result = await makeFastEngine().query('what is the carryover for contractors?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    const joined = streamed.join('');
    expect(joined, 'the real decline statement still streams').toContain('does not contain information regarding');
    expect(joined).not.toContain('Did you');
    expect(joined).not.toContain('perhaps forget');
    expect(joined).not.toContain('Once you provide');
    expect(result.answer).toBe(CAPTURED_DECLINE_FILTERED);
    expect(result.answer).not.toContain('Did you');
  });

  it('a streamed ANSWERABLE answer is byte-identical through the same wiring', async () => {
    NLC.script = [ANSWERABLE_ANSWER.slice(0, 20), ANSWERABLE_ANSWER.slice(20)];
    NLC.answer = ANSWERABLE_ANSWER;
    const streamed: string[] = [];
    const result = await makeFastEngine().query('q', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    expect(streamed.join('')).toBe(ANSWERABLE_ANSWER);
    expect(result.answer).toBe(ANSWERABLE_ANSWER);
  });
});
