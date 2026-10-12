// t157 SUPPLEMENTARY checks (issue #157, implementation-review round 1): NOT
// frozen — added after the frozen specs, to discriminate the mutation probes
// the frozen suite could not see (M1 safety-margin, M3 admission boundary)
// and to pin the one-cap reservation (query x over-cap history must KEEP its
// retrieved evidence instead of over-reserving it away).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, type LlamaEngineBackend, type LlamaEngineOptions } from '../../main/backend/inference/llama-engine';
import {
  CONTEXT_SIZE,
  MAX_HISTORY_BUDGET_TOKENS,
  CHARS_PER_TOKEN,
  countRowsWithinBudget,
  groundedContextBudgetChars,
} from '../../main/backend/inference/prompt-budget';

const GB = 1024 ** 3;

class RecordingBackend implements LlamaEngineBackend {
  questions: string[] = [];
  histories: unknown[][] = [];
  async generate(
    question: string,
    opts: { history?: unknown[]; streamCallback?: (t: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.questions.push(question);
    this.histories.push(opts.history ?? []);
    return { answer: 'supplementary', cancelled: false };
  }
  async dispose(): Promise<void> {}
}

function makeEngine(): { engine: LlamaEngine; backend: RecordingBackend } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't157-sup-'));
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  const backend = new RecordingBackend();
  const engine = new LlamaEngine({
    profile: 'quality',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality, fast },
    llamaFactory: async () => backend,
  } as Partial<LlamaEngineOptions> as LlamaEngineOptions);
  return { engine, backend };
}

describe('t157 supplementary: budget arithmetic pins (mutation probes M1/M3)', () => {
  it('the derived ceiling subtracts the documented answer budget and 512-token margin (M1: margin 512 -> 128 must flip this)', () => {
    // Empty every estimand: answer 4096, margin 512, est(0) = 0.
    // Shipped: (8192 - 4096 - 512) * 4 = 14,336. A margin mutation to 128
    // returns 15,872 and fails this pin.
    expect(
      groundedContextBudgetChars({
        answerTokens: 4096,
        systemPrompt: '',
        groundedInstruction: '',
        question: '',
        cappedHistoryText: '',
      }),
    ).toBe((CONTEXT_SIZE - 4096 - 512) * 4);
  });

  it('an exact-fit row is ADMITTED at the boundary (M3: > flipped to >= must flip this)', () => {
    // '[1] ' overhead = 4 chars; a 10-char row exactly consumes budget 14.
    expect(countRowsWithinBudget(['0123456789'], 14)).toBe(1);
    // And the next char over rejects the same row.
    expect(countRowsWithinBudget(['0123456789'], 13)).toBe(0);
  });

  it('the min() direction: a huge rag_context_truncation-style ceiling cannot loosen the derived bound (M2 companion)', () => {
    const derived = groundedContextBudgetChars({
      answerTokens: 4096,
      systemPrompt: '',
      groundedInstruction: '',
      question: '',
      cappedHistoryText: '',
    });
    expect(
      groundedContextBudgetChars({
        answerTokens: 4096,
        systemPrompt: '',
        groundedInstruction: '',
        question: '',
        cappedHistoryText: '',
        truncationChars: 1_000_000,
      }),
    ).toBe(derived);
  });
});

describe('t157 supplementary: one-cap reservation keeps evidence under an over-cap history', () => {
  it('a 12 x 3,000-char history keeps its retrieved chunks (raw-join over-reservation would zero them)', async () => {
    const { engine, backend } = makeEngine();
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [
        { text: 'evidence chunk one', source: 'doc.md', similarity: 0.9, chunkId: 'c1' },
        { text: 'evidence chunk two', source: 'doc.md', similarity: 0.88, chunkId: 'c2' },
      ],
    } as never);
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'h'.repeat(3000),
    }));
    const result = await engine.query('question?', { history });
    // 36,000 raw chars cap to the last 2 turns (~6,001 chars); the reserved
    // budget must still admit both small chunks. The pre-review raw-join
    // reservation drove the ceiling to 0 here (sources [], grounding
    // 'general').
    expect(result.sources).toEqual(['doc.md']);
    expect(result.context_length).toBe('evidence chunk one'.length + 'evidence chunk two'.length);
    expect(result.grounding).toBe('grounded');
    // And the seeded history is the CAPPED one (2 turns), not the raw 12.
    const seeded = backend.histories[0];
    expect(seeded.length).toBe(2);
  });

  it('an explicit maxTokens override makes the DERIVED branch bind (below the 20,000 default setting) and evidence survives', async () => {
    const { engine, backend } = makeEngine();
    expect(engine.applySettingsPatch({ rag_max_tokens: 4096 })).toEqual({ ok: true });
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [{ text: `${'k'.repeat(1000)} chunk`, source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
    } as never);
    const result = await engine.query('q', {});
    // answer 4096 -> derived ~14.2k chars < the 20,000 setting: the derived
    // branch governs, and the 1,006-char chunk still fits with room to spare.
    expect(result.sources).toEqual(['doc.md']);
    expect(result.grounding).toBe('grounded');
    expect(backend.questions[0]).toContain('[1] ');
  });

  it('historyToChatHistory and the query-side reservation use ONE cap: same input, same seeded turns', async () => {
    const { engine, backend } = makeEngine();
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [{ text: 'chunk', source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
    } as never);
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}`.padStart(4000, 'x'),
    }));
    await engine.query('q', { history });
    // 6 turns x 4,000 chars = 24,001 > 8,192 budget -> 2 turns survive; the
    // engine must seed exactly the turns the standalone mapper produces.
    const { historyToChatHistory } = await import('../../main/backend/inference/llama-engine');
    const mapped = historyToChatHistory(history);
    expect(backend.histories[0].length).toBe(mapped.length);
    expect(JSON.stringify(backend.histories[0])).toBe(JSON.stringify(history.slice(-2)));
    expect(mapped.length).toBe(2);
    expect(MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN).toBe(8192);
  });
});
