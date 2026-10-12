// t157 acceptance checks (issue #157): the desktop local inference path must
// respect a CONTEXT_SIZE-derived prompt budget.
//
//   C1 (AC1, DISCRIMINATING): a grounded prompt assembled from the retrieval
//      maximum (rag_n_results=10 x rag_chunk_size=8192 chars, all reachable
//      through public settings bounds) must fit
//      (CONTEXT_SIZE - answer budget - template margin) x CHARS_PER_TOKEN
//      chars, dropping trailing whole chunks rather than truncating
//      mid-chunk.
//   C2 (AC2, DISCRIMINATING): historyToChatHistory must bound the seeded
//      history to a token budget — drop oldest whole turns, keep at least
//      one, re-anchor user-first; a lone surviving oversized turn may be
//      tail-truncated to fit. A within-budget history passes through
//      unchanged.
//   C4 (AC4, PRESERVING): when retrieved context and history fit the budget,
//      the assembled grounded prompt is byte-identical to the current
//      template construction, with sources/context_length unchanged vs the
//      retrieval rows.
//
// Import discipline: NOTHING here imports node-llama-cpp directly. The engine
// runs on an injected llamaFactory RecordingBackend (CI-safe, no weights, no
// native backend), mirroring the b4-llama-engine Group A harness.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_SIZE,
  LlamaEngine,
  historyToChatHistory,
  profileGeneration,
  type LlamaEngineBackend,
} from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;
const CHARS_PER_TOKEN = 4; // browser F11 parity (rag-orchestrator CHARS_PER_TOKEN)
/** System prompt + chat-template control tokens + the question line. */
const TEMPLATE_MARGIN_TOKENS = 512;

/** Records every generate() question — the assembled grounded prompt. */
class RecordingBackend implements LlamaEngineBackend {
  questions: string[] = [];
  histories: unknown[][] = [];
  disposed = false;

  async generate(
    question: string,
    opts: { history?: unknown[]; streamCallback?: (t: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.questions.push(question);
    this.histories.push(opts.history ?? []);
    return { answer: 't157 answer', cancelled: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Quality-profile engine on the recording backend (default maxTokens 1024). */
function makeEngine(): { engine: LlamaEngine; backend: RecordingBackend } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't157-checks-'));
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

/** Retrieval surface returning fixed rows regardless of the query. */
function fixedSurface(rows: Array<{ text: string; source: string; similarity: number }>) {
  return {
    floorActive: true,
    async search() {
      return rows;
    },
  };
}

describe('C1 grounded prompt must fit the CONTEXT_SIZE budget', () => {
  it('overflowing retrieved context is trimmed by dropping trailing whole chunks', async () => {
    const { engine, backend } = makeEngine();
    // 10 chunks (rag_n_results max) x 8192 chars (rag_chunk_size max) — every
    // value reachable through public settings bounds; chunk bodies are unique
    // so survivors are identifiable by content.
    const chunks = Array.from({ length: 10 }, (_, i) => `${'x'.repeat(8191)} ${i}`);
    engine.attachRetrievalSurface(
      fixedSurface(chunks.map((text, i) => ({ text, source: `doc${i}.md`, similarity: 0.9 }))),
    );
    const question = 'what is the answer?';
    await engine.query(question);
    const prompt = backend.questions[0];
    expect(prompt).toBeDefined();

    // Whole-prompt char ceiling: (CONTEXT_SIZE - answer budget - margin)
    // tokens x CHARS_PER_TOKEN. The answer budget is the quality profile's
    // default maxTokens; the margin covers the system prompt, chat-template
    // control tokens and the question.
    const answerBudgetTokens = profileGeneration('quality').maxTokens;
    const ceiling = (CONTEXT_SIZE - answerBudgetTokens - TEMPLATE_MARGIN_TOKENS) * CHARS_PER_TOKEN;
    expect(prompt.length, `prompt chars ${prompt.length} exceed ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);

    // Whole-chunk dropping, never mid-chunk truncation: every chunk whose
    // marker starts in the prompt is present INTACT, the survivors form a
    // prefix of the ranked list (trailing drops), at least one survives, and
    // the question itself survives.
    const problems: string[] = [];
    let survivors = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      if (!prompt.includes(`[${i + 1}] `)) continue;
      if (!prompt.includes(`[${i + 1}] ${chunks[i]}`)) {
        problems.push(`chunk ${i + 1} is present but truncated mid-chunk`);
        continue;
      }
      survivors += 1;
      if (i > 0 && !prompt.includes(`[${i}] ${chunks[i - 1]}`)) {
        problems.push(`chunk ${i + 1} survived but earlier chunk ${i} did not: not a trailing drop`);
      }
    }
    if (survivors === 0) problems.push('no chunk survived the budget trim');
    if (!prompt.includes(`Question: ${question}`)) problems.push('the question itself was dropped by the budget trim');
    expect(problems).toEqual([]);
  });
});

describe('C2 seeded history must fit the history budget', () => {
  /** PR #48 prior art: the history budget in tokens. */
  const HISTORY_BUDGET_TOKENS = 2048;
  const HISTORY_BUDGET_CHARS = HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN;

  /** The text of a seeded ChatHistoryItem (user text or model response). */
  function turnText(item: unknown): string {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    if (typeof item === 'object' && item !== null && 'response' in item) {
      const response = (item as { response?: unknown }).response;
      if (Array.isArray(response)) return response.map((part) => String(part)).join('');
    }
    return '';
  }

  it('twelve turns of 4000 chars are dropped oldest-first as whole turns, user-anchored', () => {
    // 12 turns (MAX_HISTORY_TURNS) x 4000 chars — each individually small, so
    // only the aggregate overflows. Distinct markers identify which original
    // turn each kept turn came from.
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}-`.padEnd(4000, 'y'),
    }));
    const originals = history.map((turn) => turn.content);
    const seeded = historyToChatHistory(history);

    expect(seeded.length).toBeGreaterThan(0);

    const joined = seeded.map(turnText).join('\n');
    expect(joined.length, `seeded history chars ${joined.length} exceed budget ${HISTORY_BUDGET_CHARS}`).toBeLessThanOrEqual(
      HISTORY_BUDGET_CHARS,
    );

    // Re-anchored user-first after the drop.
    expect((seeded[0] as { type?: unknown }).type).toBe('user');

    // Whole-turn dropping: every kept turn is a COMPLETE original turn
    // (byte-identical content) — unless it is the only survivor and was
    // tail-truncated to fit.
    const problems: string[] = [];
    seeded.forEach((item, index) => {
      const text = turnText(item);
      if (originals.includes(text)) return;
      if (seeded.length === 1 && originals.some((original) => original.startsWith(text))) return;
      problems.push(`kept turn ${index} is not a whole original turn`);
    });
    expect(problems).toEqual([]);
  });

  it('a within-budget history is returned unchanged', () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `small turn ${i} `.padEnd(80, 'y'),
    }));
    const seeded = historyToChatHistory(history);
    expect(seeded).toHaveLength(4);
    expect(seeded.map(turnText)).toEqual(history.map((turn) => turn.content));
    expect((seeded[0] as { type?: unknown }).type).toBe('user');
    expect((seeded[1] as { type?: unknown }).type).toBe('model');
  });
});

describe('C4 within-budget grounding keeps the exact current template', () => {
  it('three 500-char chunks plus a small history produce the byte-identical prompt and unchanged provenance', async () => {
    const { engine, backend } = makeEngine();
    const chunks = Array.from({ length: 3 }, (_, i) => `chunk-${i}-`.padEnd(500, 'z'));
    const rows = chunks.map((text, i) => ({ text, source: `doc${i}.md`, similarity: 0.9 }));
    engine.attachRetrievalSurface(fixedSurface(rows));
    const question = 'what is the answer?';
    const history = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const result = await engine.query(question, { history });
    const prompt = backend.questions[0];
    expect(prompt).toBeDefined();

    // The exact current construction (llama-engine.ts groundedQuestion):
    // instruction line, blank line, chunks as bracket-indexed text joined by
    // blank lines, blank lines, Question line. Byte-identical.
    const expected =
      'Answer the question using the retrieved context when relevant.\n\n' +
      chunks.map((text, index) => `[${index + 1}] ${text}`).join('\n\n') +
      '\n\n\nQuestion: ' +
      question;
    expect(prompt).toBe(expected);

    // Provenance fields unchanged vs the retrieval rows: sources in rank
    // order (deduped) and context_length as the summed chunk lengths.
    expect(result.sources).toEqual(['doc0.md', 'doc1.md', 'doc2.md']);
    expect(result.context_length).toBe(3 * 500);
  });
});
