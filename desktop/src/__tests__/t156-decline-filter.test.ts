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

  it('SCOPE GUARD: artefact-SHAPED text with no decline marker is byte-identical (the filter must not fire marker-less)', () => {
    // 4.5 review finding 2: the desktop half of the scope-guard pair was
    // unpinned (only the web twin pinned it). Artefact sentence shapes
    // without a preceding decline marker must pass through untouched.
    const artefactShaped =
      'To reset your password, first open Settings. Did you forget to include the document upload step? ' +
      'Once you provide the completed form the administrator approves it.';
    expect(filterDeclineSentences(artefactShaped)).toBe(artefactShaped);
  });

  it('the empty string is a byte-identical passthrough', () => {
    expect(filterDeclineSentences('')).toBe('');
  });

  it('PRR-103 guard: a marker clause inside an artefact sentence does NOT empty the answer', () => {
    // The marker arms the filter; the artefact pattern then consumed the only
    // sentence, leaving an empty bubble. The guard returns the original.
    const text =
      'Once you provide the relevant document, I will be able to determine whether the context does not contain the answer.';
    expect(filterDeclineSentences(text)).toBe(text);
  });

  it('PRR-104 guard: the artefact tail is bounded — colon-joined real content survives', () => {
    const text =
      'The context does not contain dosage data. Did you forget to include the document: the correct answer is 42 mg/kg daily.';
    const filtered = filterDeclineSentences(text);
    expect(filtered).toContain('The context does not contain dosage data.');
    expect(filtered).toContain('42 mg/kg daily');
  });
});

describe('#156 generate() wiring: streamed declines never surface the artefact', () => {
  it('a streamed decline (marker first, artefact in a later chunk) hides the artefact from the stream AND the answer', async () => {
    // Two-chunk split (marker sentence, then the artefact sentences): the
    // filter must work on the ACCUMULATED text, not per chunk. The
    // word-by-word case below is the production-faithful one.
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

  it('STREAMING DISCIPLINE: token-level chunking never surfaces an artefact word, never splices, and the joined stream equals the filtered projection', async () => {
    // 4.5 review finding 1: node-llama-cpp flushes onTextChunk per TOKEN. The
    // emission discipline (decided-sentence boundaries + terminal flush) must
    // hold at word granularity — no partial artefact sentence leaks before
    // its terminator, no offset-spliced words appear.
    const words = CAPTURED_DECLINE.split(/(\s+)/); // keep the separators
    NLC.script = words.filter((w) => w.length > 0);
    NLC.answer = CAPTURED_DECLINE;
    const streamed: string[] = [];
    const result = await makeFastEngine().query('what is the carryover?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    const joined = streamed.join('');
    expect(joined).toContain('does not contain information regarding');
    expect(joined).not.toContain('Did you');
    expect(joined).not.toContain('forget to include');
    expect(joined).not.toContain('Once you provide');
    // No mid-word splice: every emission must start at a whitespace-or-start
    // boundary of the filtered projection, and the joined stream must be
    // exactly the filter applied to the full raw answer.
    expect(joined).toBe(CAPTURED_DECLINE_FILTERED);
    expect(result.answer).toBe(CAPTURED_DECLINE_FILTERED);
  });

  it('PRR-102 ORDERING: artefact-before-marker no longer splices — the flush delivers the full filtered answer', async () => {
    // Artefact-first ordering: old length-based emission spliced mid-answer.
    // The content guard defers emission on divergence; the terminal flush
    // then delivers the complete filtered answer after a separator.
    const raw = 'Did you forget to attach the document? The provided context does not mention that topic. Here is the rest of the answer text.';
    const words = raw.split(/(\s+)/);
    NLC.script = words.filter((w) => w.length > 0);
    NLC.answer = raw;
    const streamed: string[] = [];
    const result = await makeFastEngine().query('is the topic covered?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    const joined = streamed.join('');
    const expected = filterDeclineSentences(raw);
    // The final flush carries the complete correct answer.
    expect(joined).toContain(expected);
    expect(result.answer).toBe(expected);
    // No mid-word splice: every emission is either the leaked prefix, the
    // separator, or the corrected answer.
    expect(joined.startsWith('Did you forget to attach the document?')).toBe(true);
  });

  it('TERMINAL FLUSH: an answer ending WITHOUT a terminator still emits its tail (joined == filter(raw))', async () => {
    // 4.5 round-2 finding: maxTokens truncation is production-common (fast
    // tier caps at 384 tokens), and then the flush is the ONLY path emitting
    // the final partial sentence. Deleting flushSurface() must fail this.
    const truncated = CAPTURED_DECLINE.slice(0, -1); // drop the final '.'
    const words = truncated.split(/(\s+)/);
    NLC.script = words.filter((w) => w.length > 0);
    NLC.answer = truncated;
    const streamed: string[] = [];
    const result = await makeFastEngine().query('what is the carryover?', {
      streamCallback: (chunk: string) => streamed.push(chunk),
    });
    const expected = filterDeclineSentences(truncated);
    expect(streamed.join('')).toBe(expected);
    expect(result.answer).toBe(expected);
    // The tail (no terminator) is exactly what only the flush can emit.
    expect(expected).not.toMatch(/[.!?]$/);
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
