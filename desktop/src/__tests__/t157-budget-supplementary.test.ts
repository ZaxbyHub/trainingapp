// t157 SUPPLEMENTARY checks (issue #157, implementation-review round 1): NOT
// frozen — added after the frozen specs, to discriminate the mutation probes
// the frozen suite could not see (M1 safety-margin, M3 admission boundary)
// and to pin the one-cap reservation (query x over-cap history must KEEP its
// retrieved evidence instead of over-reserving it away).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, historyToChatHistory, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine';
import {
  CONTEXT_SIZE,
  MAX_HISTORY_BUDGET_TOKENS,
  CHARS_PER_TOKEN,
  capHistoryTokens,
  countRowsWithinBudget,
  estimateTokens,
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
  tmpDirs.push(dir);
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
  });
  return { engine, backend };
}

// PRR-023: clean up the per-makeEngine temp dirs (was leaking ~8/run).
const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

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
    const mapped = historyToChatHistory(history);
    expect(backend.histories[0].length).toBe(mapped.length);
    expect(JSON.stringify(backend.histories[0])).toBe(JSON.stringify(history.slice(-2)));
    expect(mapped.length).toBe(2);
    expect(MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN).toBe(8192);
  });
});

describe('t157 supplementary: PR-review feedback pins (round pr162-20261012)', () => {
  it('PRR-003: an assistant-first WITHIN-budget history maps byte-identically (no re-anchor)', () => {
    // Documented passthrough contract: re-anchor only runs AFTER a drop.
    // An unconditional-reanchor mutant would strip the leading assistant turn.
    const history = [
      { role: 'assistant', content: 'a'.repeat(300) },
      { role: 'user', content: 'u'.repeat(300) },
    ];
    const mapped = historyToChatHistory(history);
    expect(mapped).toEqual([
      { type: 'model', response: ['a'.repeat(300)] },
      { type: 'user', text: 'u'.repeat(300) },
    ]);
  });

  it('PRR-004: >12-turn in-budget history — the seeded array and the charged text use the same slice(-12)', async () => {
    const { engine, backend } = makeEngine();
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [{ text: 'chunk', source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
    } as never);
    // 20 turns x 400 chars = 8,179 joined <= 8,192 char cap: cap is a no-op,
    // only the turn-cap slice reduces it to the last 12 — the reservation
    // must charge exactly those 12, not all 20.
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}`.padStart(400, 'y'),
    }));
    await engine.query('q', { history });
    // generate() receives the capped (20-turn) array; the 12-turn slice and
    // mapping happen inside historyToChatHistory at the setChatHistory seam.
    const seeded = backend.histories[0] as Array<{ role: string; content: string }>;
    expect(seeded.length).toBe(20);
    const mapped = historyToChatHistory(seeded);
    expect(mapped.length).toBe(12);
    // Seeded window == last 12 raw turns (user at even index, so window starts
    // with the user turn at raw index 8).
    expect(mapped[0]).toEqual({ type: 'user', text: '8'.padStart(400, 'y') });
  });

  it('PRR-011/014: the derived branch binds at the call site — a 16,000-char chunk drops under an explicit maxTokens=4096 but survives at the profile default', async () => {
    // Discriminates groundedContextBudgetChars's min() wiring end-to-end:
    // chunk 16,000 chars fits the 20,000 setting but exceeds derived
    // (~14,052) at maxTokens 4096 — dropping proves DERIVED governs; the
    // companion default-profile case proves the chunk is not intrinsically
    // droppable (derived ~26,160 > 16,000, setting 20,000 > 16,000).
    const run = async (maxTokens?: number) => {
      const { engine } = makeEngine();
      if (maxTokens !== undefined) {
        expect(engine.applySettingsPatch({ rag_max_tokens: maxTokens })).toEqual({ ok: true });
      }
      engine.attachRetrievalSurface({
        floorActive: true,
        search: async () => [{ text: 'k'.repeat(16_000), source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
      } as never);
      return engine.query('q?', {});
    };
    const bound = await run(4096);
    expect(bound.sources).toEqual([]);
    expect(bound.grounding).toBe('general');
    const unbound = await run(undefined);
    expect(unbound.sources).toEqual(['doc.md']);
    expect(unbound.grounding).toBe('grounded');
  });

  it('PRR-014: exact per-channel arithmetic — a longer question shrinks the ceiling by exactly ceil(len/4)', () => {
    const base = { answerTokens: 4096, systemPrompt: 's'.repeat(200), groundedInstruction: 'g'.repeat(62), question: '', cappedHistoryText: '' };
    const withQuestion = { ...base, question: 'q'.repeat(400) };
    expect(base.truncationChars === undefined).toBe(true);
    // The ceiling is in CHARS: +100 tokens of question -> -400 chars of budget.
    expect(groundedContextBudgetChars(base) - groundedContextBudgetChars(withQuestion)).toBe(400);
    // CJK is charged 1 token per code point (PRR-001): 400 CJK chars cost
    // 400 tokens, not 100.
    const withCjk = { ...base, question: '问'.repeat(400) };
    expect(groundedContextBudgetChars(base) - groundedContextBudgetChars(withCjk)).toBe(1600);
    expect(estimateTokens('问'.repeat(400))).toBe(400);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('PRR-014: multi-row admission charges the [n] prefix and the \\n\\n joiner at the boundary', () => {
    // row 1: overhead 4 + 2 chars = 6; row 2: overhead 4 + 2 + joiner 2 = 8.
    expect(countRowsWithinBudget(['ab', 'cd'], 14)).toBe(2);
    expect(countRowsWithinBudget(['ab', 'cd'], 13)).toBe(1);
    expect(countRowsWithinBudget(['ab', 'cd'], 5)).toBe(0);
  });

  it('PRR-014: re-anchor runs after a drop on a non-alternating over-budget history', () => {
    const kept = capHistoryTokens(
      [
        { role: 'assistant', content: 'a'.repeat(4000) },
        { role: 'assistant', content: 'b'.repeat(4000) },
        { role: 'user', content: 'u'.repeat(500) },
        { role: 'assistant', content: 'c'.repeat(100) },
      ],
      MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN,
    );
    // Drop the oldest (8,602 > 8,192) -> [a4000,u500,a100] fits, starts
    // assistant -> re-anchor drops it -> user-first pair remains.
    expect(kept.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(kept[0]?.content.length).toBe(500);
  });

  it('PRR-014/016: an all-assistant over-budget history keeps its newest turn (keep>=1 wins over re-anchor)', () => {
    const kept = capHistoryTokens(
      [
        { role: 'assistant', content: 'a'.repeat(4000) },
        { role: 'assistant', content: 'b'.repeat(5000) },
      ],
      MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN,
    );
    expect(kept.length).toBe(1);
    expect(kept[0]?.role).toBe('assistant');
    expect(kept[0]?.content).toBe('b'.repeat(5000));
    // Mapped shape documents the intent (model-first lone survivor).
    expect(historyToChatHistory([{ role: 'assistant', content: 'b'.repeat(5000) }])).toEqual([
      { type: 'model', response: ['b'.repeat(5000)] },
    ]);
  });

  it('PRR-015: a lone oversized turn is tail-truncated to the budget, code-point safe; maxChars<=0 truncates to empty', () => {
    const lone = capHistoryTokens([{ role: 'user', content: 'z'.repeat(20000) }], 8192);
    expect(lone[0]?.content.length).toBe(8192);
    // Surrogate safety: the cut must never end on an UNPAIRED high surrogate
    // (a trailing low surrogate is a complete pair and is fine).
    const emoji = 'a'.repeat(8190) + '😀'.repeat(100);
    const cut = capHistoryTokens([{ role: 'user', content: emoji }], 8191);
    const last = cut[0]!.content.charCodeAt(cut[0]!.content.length - 1);
    const endsWithLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    expect(endsWithLoneHighSurrogate).toBe(false);
    // maxChars <= 0: must truncate to empty, NOT return the full string
    // (JS slice(-0) === slice(0) — the bug this pin kills).
    const degenerate = capHistoryTokens([{ role: 'user', content: 'z'.repeat(20000) }], 0);
    expect(degenerate[0]?.content).toBe('');
  });

  it('PRR-014: partial budget drop keeps survivor-consistent provenance (sources/context_length/cited)', async () => {
    const { engine } = makeEngine();
    expect(engine.applySettingsPatch({ rag_context_truncation: 500 })).toEqual({ ok: true });
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [
        { text: 's'.repeat(100), source: 'small.md', similarity: 0.9, chunkId: 'c1' },
        { text: 'h'.repeat(25_000), source: 'huge.md', similarity: 0.8, chunkId: 'c2' },
      ],
    } as never);
    const result = await engine.query('q?', {});
    expect(result.sources).toEqual(['small.md']);
    expect(result.context_length).toBe(100);
    expect(result.grounding).toBe('grounded');
    expect(result.cited?.map((c) => c.chunkId)).toEqual(['c1']);
  });

  it('PRR-007: a budget that drops every row falls back to the bare question (no grounded-instruction shell)', async () => {
    const { engine, backend } = makeEngine();
    expect(engine.applySettingsPatch({ rag_context_truncation: 10 })).toEqual({ ok: true });
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [{ text: 'chunk for the question', source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
    } as never);
    const result = await engine.query('bare?', {});
    expect(result.grounding).toBe('general');
    expect(result.sources).toEqual([]);
    expect(backend.questions[0]).toBe('bare?');
    expect(backend.questions[0]).not.toContain('retrieved context');
  });
});
