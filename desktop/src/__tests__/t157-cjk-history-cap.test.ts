// t157-cjk-history-cap.test.ts — issue #280 (C1 / check C15): the
// conversation-history token cap must measure CJK histories in ESTIMATED
// tokens, not the 4-chars/token Latin-average character count.
//
// RED at base, GREEN after the fix: at the base revision the production cap
// (capContractHistory -> capHistoryTokens with an 8,192-CHAR budget) reads a
// legal six-turn CJK conversation (~6,765 chars) as within budget and keeps
// every turn, but the model tokenizes those code points at ~1-2 chars/token,
// so the seeded history alone costs ~6,760 estimated tokens against a
// MAX_HISTORY_BUDGET_TOKENS reservation of 2,048 — the grounded-context
// ceiling collapses to 0 and every retrieved row is dropped (leg 2 below).
// After the fix capContractHistory runs capHistoryByEstimatedTokens, which
// delegates CJK-free histories to the unchanged character cap byte-identically
// (leg 3) and, for any-CJK histories, charges each CJK code point a full
// token under BOTH the per-turn sum and the joined-text estimate (legs 1, 4,
// 6), with a surrogate-safe tail cut for a lone oversized survivor (leg 5).
//
// Import discipline: the engine runs on an injected llamaFactory recording
// backend (CI-safe, no weights, no native backend) — the t157 harness idiom.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, capContractHistory, profileGeneration, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine';
import {
  CHARS_PER_TOKEN,
  MAX_HISTORY_BUDGET_TOKENS,
  capHistoryByEstimatedTokens,
  capHistoryTokens,
  estimateTokens,
  groundedContextBudgetChars,
} from '../../main/backend/inference/prompt-budget';

const GB = 1024 ** 3;
/** A CJK code point inside prompt-budget's CJK_RANGE (Han block). */
const CJK = '训';

const SYSTEM_PROMPT =
  "You are TrainingApp's local assistant. Answer the user's question directly and concisely. " +
  'When retrieved context is provided, answer only from that context and say when it does not contain the answer.';
const GROUNDED_INSTRUCTION = 'Answer the question using the retrieved context when relevant.';

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

function stageModels(): { quality: string; fast: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't157-cjk-'));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast };
}

/** Records every generate() question — the assembled grounded prompt. */
class RecordingBackend implements LlamaEngineBackend {
  questions: string[] = [];
  histories: unknown[][] = [];
  async generate(
    question: string,
    opts: { history?: unknown[]; streamCallback?: (t: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.questions.push(question);
    this.histories.push(opts.history ?? []);
    return { answer: 't157 cjk answer', cancelled: false };
  }
  async dispose(): Promise<void> {}
}

function makeEngine(): { engine: LlamaEngine; backend: RecordingBackend } {
  const models = stageModels();
  const backend = new RecordingBackend();
  const engine = new LlamaEngine({
    profile: 'quality',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models,
    llamaFactory: async () => backend,
  });
  return { engine, backend };
}

/** Three user/assistant pairs of 800/1460-char CJK turns (the #280 fixture). */
function sixCjkTurns(): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i < 3; i += 1) {
    turns.push({ role: 'user', content: CJK.repeat(800) });
    turns.push({ role: 'assistant', content: CJK.repeat(1460) });
  }
  return turns;
}

describe('C15 leg 1: the production cap keeps a six-turn CJK history inside the token budget', () => {
  it('capContractHistory: per-turn sum <= 2048 AND joined estimate <= 2048 AND the grounded-context budget stays > 0', () => {
    const history = sixCjkTurns();
    // Sanity: the fixture is the over-budget CJK shape the issue describes
    // (per-turn sum ~6,760 estimated tokens vs the 2,048 budget — the char
    // cap at base read the same text as ~6,765 chars <= 8,192 and kept it).
    expect(history).toHaveLength(6);
    expect(estimateTokens(history.map((t) => t.content).join('\n'))).toBeGreaterThan(MAX_HISTORY_BUDGET_TOKENS);

    const kept = capContractHistory(history);
    expect(kept.length).toBeGreaterThanOrEqual(1);

    const perTurnSum = kept.reduce((total, turn) => total + estimateTokens(turn.content), 0);
    expect(perTurnSum, 'the per-turn estimate sum must fit the budget').toBeLessThanOrEqual(MAX_HISTORY_BUDGET_TOKENS);

    const joined = kept.map((turn) => turn.content).join('\n');
    expect(estimateTokens(joined), 'the JOINED estimate (what the reservation charges) must fit the budget').toBeLessThanOrEqual(
      MAX_HISTORY_BUDGET_TOKENS,
    );

    // The reservation inputs built like the production query path
    // (llama-engine query(): quality answer budget, the real system prompt
    // and grounded instruction, a 200-char question, the capped history).
    const budget = groundedContextBudgetChars({
      answerTokens: profileGeneration('quality').maxTokens,
      systemPrompt: SYSTEM_PROMPT,
      groundedInstruction: GROUNDED_INSTRUCTION,
      question: 'q'.repeat(200),
      cappedHistoryText: joined,
    });
    expect(budget, 'the CJK-capped history leaves grounded-context budget for retrieved evidence').toBeGreaterThan(0);
  });
});

describe('C15 leg 2: the b4 stub engine query path keeps the retrieved row under the same history', () => {
  it('a grounded query with the six CJK turns still assembles a prompt containing the retrieved row', async () => {
    const { engine, backend } = makeEngine();
    engine.attachRetrievalSurface({
      floorActive: true,
      search: async () => [{ text: 'RETRIEVED-EVIDENCE-ROW marker', source: 'doc.md', similarity: 0.9, chunkId: 'c1' }],
    } as never);
    const result = await engine.query('q'.repeat(200), { history: sixCjkTurns() });
    const prompt = backend.questions[0];
    expect(prompt).toBeDefined();
    // At base the char cap kept all six turns, the reservation collapsed to
    // zero and every row was dropped — the prompt degenerated to the bare
    // question. After the fix the row survives inside the assembled prompt.
    expect(prompt).toContain('RETRIEVED-EVIDENCE-ROW marker');
    expect(result.sources).toEqual(['doc.md']);
    expect(result.grounding).toBe('grounded');
    // And the seeded history is the CAPPED one (not the raw six turns).
    expect(backend.histories[0].length).toBeLessThan(6);
  });
});

describe('C15 leg 3: Latin histories delegate to the unchanged character cap (exact kept set)', () => {
  it('two 4096-char Latin turns keep EXACTLY what capHistoryTokens(turns, 2048*4) keeps (the oldest drops)', () => {
    const turns = [
      { role: 'user', content: 'a'.repeat(4096) },
      { role: 'assistant', content: 'a'.repeat(4096) },
    ];
    // The delegation discriminator: the char cap drops the oldest turn
    // (joined length 8193 > 8192) while a per-turn token path would keep
    // both (1024 + 1024 = 2048 <= 2048).
    const expected = capHistoryTokens(turns, MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN);
    expect(expected).toHaveLength(1);
    const kept = capHistoryByEstimatedTokens(turns, MAX_HISTORY_BUDGET_TOKENS);
    expect(kept).toEqual(expected);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.content).toBe(turns[1]!.content);
  });
});

describe('C15 leg 4: the joiner boundary — per-turn fits, joined estimate exceeds', () => {
  it('two 4092-char Latin + one CJK turns: per-turn 2048 == budget but joined 2049 > budget, so a turn drops', () => {
    const turns = [
      { role: 'user', content: 'a'.repeat(4092) + CJK },
      { role: 'assistant', content: 'a'.repeat(4092) + CJK },
    ];
    // Per-turn: 1 CJK + ceil(4092/4) = 1 + 1023 = 1024 each -> sum 2048 == budget.
    expect(turns.map((t) => estimateTokens(t.content))).toEqual([1024, 1024]);
    // Joined: 8187 chars, 2 CJK -> 2 + ceil(8185/4) = 2049 > budget.
    expect(estimateTokens(turns.map((t) => t.content).join('\n'))).toBe(2049);
    const kept = capHistoryByEstimatedTokens(turns, MAX_HISTORY_BUDGET_TOKENS);
    // The BOTH-bounds rule must drop a turn; a per-turn-only mutant keeps both.
    expect(kept.length).toBeLessThan(turns.length);
    expect(kept).toHaveLength(1);
  });
});

describe('C15 leg 5: a lone oversized CJK turn is surrogate-safe tail-truncated', () => {
  it('pure-CJK lone turn: the direct estimate of the truncated content fits the budget exactly', () => {
    const kept = capHistoryByEstimatedTokens(
      [{ role: 'user', content: CJK.repeat(3000) }],
      MAX_HISTORY_BUDGET_TOKENS,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.role).toBe('user');
    expect(estimateTokens(kept[0]!.content), 'the truncated turn\'s direct estimate is within the budget').toBeLessThanOrEqual(
      MAX_HISTORY_BUDGET_TOKENS,
    );
    // CJK is charged one token per code point: the cut keeps exactly 2048.
    expect(kept[0]!.content).toBe(CJK.repeat(MAX_HISTORY_BUDGET_TOKENS));
  });

  it('mixed CJK + surrogate-pair content: the cut never opens or closes on an unpaired surrogate', () => {
    // The trailing shape forces the token-aware cut INTO the leading emoji
    // field at an odd UTF-16 offset (a LOW surrogate) — without the trim the
    // kept text would open with an orphaned low surrogate.
    const content = CJK + '😀'.repeat(3000) + 'a' + '😀'.repeat(1500) + CJK.repeat(50);
    expect(estimateTokens(content)).toBeGreaterThan(MAX_HISTORY_BUDGET_TOKENS);
    const kept = capHistoryByEstimatedTokens([{ role: 'user', content }], MAX_HISTORY_BUDGET_TOKENS);
    expect(kept).toHaveLength(1);
    const truncated = kept[0]!.content;
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated.length).toBeLessThan(content.length);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(MAX_HISTORY_BUDGET_TOKENS);
    const first = truncated.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff, 'no leading lone LOW surrogate at the cut start').toBe(false);
    const last = truncated.charCodeAt(truncated.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff, 'no trailing lone HIGH surrogate').toBe(false);
  });
});

describe('C15 leg 6: the rounding boundary — per-turn ceil over-counts vs the joined estimate', () => {
  it('a history whose JOINED estimate fits but per-turn sum exceeds still drops (both bounds required)', () => {
    const turns = [
      { role: 'user', content: CJK },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'a' },
    ];
    // Per-turn: ceil rounding charges each 1-char turn a FULL token -> 3 > 2.
    // Joined: '中\na\na' = 5 chars, 1 CJK -> 1 + ceil(4/4) = 2 <= 2.
    expect(turns.reduce((total, t) => total + estimateTokens(t.content), 0)).toBe(3);
    expect(estimateTokens(turns.map((t) => t.content).join('\n'))).toBe(2);
    const kept = capHistoryByEstimatedTokens(turns, 2);
    // A joined-only mutant keeps all three; the per-turn bound drops the oldest.
    expect(kept.map((t) => t.content)).toEqual(['a', 'a']);
    expect(kept.map((t) => t.role)).toEqual(['user', 'assistant']);
  });
});
