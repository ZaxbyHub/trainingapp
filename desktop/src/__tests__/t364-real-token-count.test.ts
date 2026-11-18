// frozen-check C6 — #364 AC1: desktop prompt budgeting reports BOTH the
// estimate and the real tokenizer count in diagnostics, profile-scoped.
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f. The implementer must make this
// pass WITHOUT editing it; canonical copy dropped byte-identical at
// desktop/src/__tests__/t364-real-token-count.test.ts.
//
// Seam (mirrored verbatim from t157-budget-supplementary.test.ts /
// b4-llama-engine.test.ts — no new harness invented):
//   - LlamaEngine constructed with dummy staged models + a llamaFactory
//     returning a RecordingBackend (LlamaEngineBackend double).
//   - engine.attachRetrievalSurface({ floorActive, search }) for grounded
//     rows; engine.applySettingsPatch({ rag_context_truncation }) to force
//     a budget drop; engine.query(question, {}).
//   - vi.spyOn(console, 'info') captures the diagnostics records.
//
// FROZEN OBSERVABLE (declared so the implementer cannot dodge it):
//   1. ADDITIVE BACKEND SEAM: LlamaEngineBackend gains an OPTIONAL method
//         realPromptTokenCount?(): number | null
//      through which the engine obtains the backend-measured prompt token
//      count after a query (node-llama-cpp tokenMeter/model.tokenize in the
//      real backend; the deterministic double here returns a constant).
//      A backend without the member reports "unavailable" (null).
//   2. DIAGNOSTICS RECORD: during a query, a console.info record whose
//      first argument is a string beginning with '[RAG]' (the existing
//      diagnostics family) carries an object payload with EXACTLY these
//      frozen keys (additive; other keys allowed):
//         profile: the serving inference profile name ('fast'/'quality')
//         estimatedPromptTokens: finite integer > 0 (the chars-class estimate
//           of the FULL prompt channel set — system prompt, grounded
//           instruction, question, and capped history — the same inputs
//           prompt-budget.ts feeds groundedContextBudgetChars)
//         promptChars: finite integer > 0, the character length of the exact
//           text the estimate was computed over (PC-09: lets the spec pin
//           the estimate is DERIVED, not a constant)
//         realPromptTokens: the number reported by the backend accessor,
//                           or null when the backend exposes none
//      Estimate invariants pinned (PC-09, PC2-03 EXACT equality, not bounds):
//      with the exported channel constants (llama-engine.ts must export
//      SYSTEM_PROMPT and GROUNDED_INSTRUCTION — implementation-side change
//      declared in the plan), the record must satisfy
//         estimatedPromptTokens === estimateTokens(SYSTEM_PROMPT +
//             GROUNDED_INSTRUCTION + question + cappedHistoryText)
//         promptChars === (SYSTEM_PROMPT + GROUNDED_INSTRUCTION + question +
//             cappedHistoryText).length
//      for the spec-constructed inputs (fixture histories are within
//      MAX_HISTORY_BUDGET_TOKENS and <= 12 turns so the cap is an identity;
//      estimateTokens is imported from prompt-budget). The CJK leg pins
//      estimateTokens' CJK behavior; the history leg pins that capped
//      history participates.
//   3. PRESERVATION: the existing drop-conditional '[RAG] budget' record
//      still fires, unchanged (droppedForBudget + scale 'char-budget').
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaEngine, type LlamaEngineBackend, SYSTEM_PROMPT, GROUNDED_INSTRUCTION } from '../../main/backend/inference/llama-engine';
import { estimateTokens } from '../../main/backend/inference/prompt-budget';

const GB = 1024 ** 3;

// Deterministic real-count constant. Chosen far from any plausible chars/4
// estimate of this fixture's prompt (max ~30k chars -> estimate < ~8k), so
// estimatedPromptTokens === realPromptTokens can only happen by copying.
const REAL_COUNT = 90210;

const QUESTION =
  'How should the splint be secured during transport, considering repeated ' +
  'checks for swelling and the two-strap tightening procedure from the drill?';

/** RecordingBackend (t157 idiom) + the frozen additive real-count seam. */
class CountingBackend implements LlamaEngineBackend {
  questions: string[] = [];
  realCountCalls = 0;
  async generate(
    question: string,
    opts: { history?: unknown[]; streamCallback?: (t: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.questions.push(question);
    return { answer: 'dual-report-check', cancelled: false };
  }
  async dispose(): Promise<void> {}
  realPromptTokenCount(): number | null {
    this.realCountCalls += 1;
    return REAL_COUNT;
  }
}

/** The base-interface double: no real-count capability exposed. */
class BareBackend implements LlamaEngineBackend {
  async generate(): Promise<{ answer: string; cancelled: boolean }> {
    return { answer: 'bare', cancelled: false };
  }
  async dispose(): Promise<void> {}
}

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

function makeEngine(profile: 'fast' | 'quality', backend: LlamaEngineBackend): LlamaEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't364-'));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return new LlamaEngine({
    profile,
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality, fast },
    llamaFactory: async () => backend,
  });
}

function attachDroppingSurface(engine: LlamaEngine): void {
  engine.applySettingsPatch({ rag_context_truncation: 500 });
  engine.attachRetrievalSurface({
    floorActive: true,
    search: async () => [
      { text: 's'.repeat(100), source: 'small.md', similarity: 0.9, chunkId: 'c1' },
      { text: 'h'.repeat(25_000), source: 'huge.md', similarity: 0.8, chunkId: 'c2' },
    ],
  } as never);
}

interface TokenRecord {
  profile?: unknown;
  estimatedPromptTokens?: unknown;
  promptChars?: unknown;
  realPromptTokens?: unknown;
}

/** Find the frozen dual-report diagnostics record in captured calls. */
function tokenRecord(info: ReturnType<typeof vi.spyOn>): TokenRecord | undefined {
  for (const call of info.mock.calls) {
    const tag = call[0];
    const payload = call[1];
    if (
      typeof tag === 'string' &&
      tag.startsWith('[RAG]') &&
      payload !== null &&
      typeof payload === 'object' &&
      'estimatedPromptTokens' in (payload as Record<string, unknown>)
    ) {
      return payload as TokenRecord;
    }
  }
  return undefined;
}

describe('t364 real-token-count (#364 AC1): diagnostics report estimate AND real count, profile-scoped', () => {
  it('a query emits a [RAG] diagnostics record carrying estimatedPromptTokens and the backend-reported realPromptTokens (real-token-count)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const backend = new CountingBackend();
      const engine = makeEngine('fast', backend);
      attachDroppingSurface(engine);
      const result = await engine.query(QUESTION, {});
      expect(result.cancelled).not.toBe(true);

      const record = tokenRecord(info);
      expect(record, 'expected a [RAG] diagnostics record with estimatedPromptTokens').toBeDefined();
      const estimate = record!.estimatedPromptTokens;
      expect(
        Number.isInteger(estimate) && (estimate as number) > 0 && Number.isFinite(estimate as number),
        'estimate must be a positive finite integer',
      ).toBe(true);
      // The prompt contains the question, so any sane estimate exceeds
      // ceil(questionChars / 4) — discriminates against constant-1 fakes.
      expect(estimate as number).toBeGreaterThanOrEqual(Math.ceil(QUESTION.length / 4));
      expect(record!.realPromptTokens, 'the real count must flow from the backend accessor').toBe(REAL_COUNT);
      expect(record!.realPromptTokens).not.toBe(record!.estimatedPromptTokens);
      // The backend accessor really was consulted by the engine.
      expect(backend.realCountCalls).toBeGreaterThanOrEqual(1);

      // PC2-03 exact channel equality (kills fabricated promptChars and any
      // bounds-only mutant): the record's estimate must equal estimateTokens
      // over the reconstructed channel string — no proxy inequalities.
      const expectedChannel = SYSTEM_PROMPT + GROUNDED_INSTRUCTION + QUESTION + '';
      expect(record!.promptChars, 'promptChars must be the exact channel length').toBe(expectedChannel.length);
      expect(record!.estimatedPromptTokens, 'estimatedPromptTokens must equal estimateTokens(channel)').toBe(estimateTokens(expectedChannel));

      // Preservation: the drop-conditional budget record still fires,
      // unchanged (t157 PRR-008 pin).
      const budgetLogs = info.mock.calls.filter((call) => call[0] === '[RAG] budget');
      expect(budgetLogs.length).toBe(1);
      expect(budgetLogs[0]?.[1]).toMatchObject({ droppedForBudget: 1, scale: 'char-budget' });
    } finally {
      info.mockRestore();
    }
  });

  it('the dual-report record is profile-scoped: a quality-profile engine labels its record quality (real-token-count)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const engine = makeEngine('quality', new CountingBackend());
      attachDroppingSurface(engine);
      await engine.query(QUESTION, {});

      const record = tokenRecord(info);
      expect(record, 'expected the dual-report record on the quality profile too').toBeDefined();
      expect(record!.profile, 'the record must name the serving profile').toBe('quality');
      expect(record!.realPromptTokens).toBe(REAL_COUNT);
    } finally {
      info.mockRestore();
    }
  });

  it('a CJK-heavy prompt yields estimatedPromptTokens strictly above ceil(promptChars/4) — the estimator is wired, not chars/4 (real-token-count)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const engine = makeEngine('fast', new CountingBackend());
      attachDroppingSurface(engine);
      const cjk = '患 者 血 糖 监 测 与 胰 岛 素 给 药 方 案 '.repeat(40);
      await engine.query(cjk, {});

      const record = tokenRecord(info);
      expect(record, 'expected the dual-report record on the CJK query').toBeDefined();
      const expectedCjkChannel = SYSTEM_PROMPT + GROUNDED_INSTRUCTION + cjk + '';
      expect(record!.promptChars).toBe(expectedCjkChannel.length);
      expect(record!.estimatedPromptTokens, 'CJK estimate must equal estimateTokens over the exact channel').toBe(estimateTokens(expectedCjkChannel));
      expect(
        (record!.estimatedPromptTokens as number) > Math.ceil(expectedCjkChannel.length / 4),
        'CJK content must push the estimate above the plain chars/4 floor (estimator wiring proof)',
      ).toBe(true);
      expect(record!.realPromptTokens).toBe(REAL_COUNT);
    } finally {
      info.mockRestore();
    }
  });

  it('conversation history grows estimatedPromptTokens strictly over the no-history query (real-token-count)', async () => {
    const history = [
      { role: 'user', content: 'u'.repeat(2400) },
      { role: 'assistant', content: 'a'.repeat(2400) },
    ];

    const infoPlain = vi.spyOn(console, 'info').mockImplementation(() => {});
    let plainEstimate = 0;
    try {
      const engine = makeEngine('fast', new CountingBackend());
      attachDroppingSurface(engine);
      await engine.query(QUESTION, {});
      const record = tokenRecord(infoPlain);
      expect(record).toBeDefined();
      plainEstimate = record!.estimatedPromptTokens as number;
    } finally {
      infoPlain.mockRestore();
    }

    const infoHist = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const engine = makeEngine('fast', new CountingBackend());
      attachDroppingSurface(engine);
      await engine.query(QUESTION, { history });
      const record = tokenRecord(infoHist);
      expect(record).toBeDefined();
      const expectedHistChannel = SYSTEM_PROMPT + GROUNDED_INSTRUCTION + QUESTION + history.map((t) => t.content).join('\n');
      expect(record!.promptChars).toBe(expectedHistChannel.length);
      expect(record!.estimatedPromptTokens, 'capped history must be an estimate channel (exact equality)').toBe(estimateTokens(expectedHistChannel));
      expect(
        (record!.estimatedPromptTokens as number) > plainEstimate,
        'the estimate must account for the capped-history channel, not only the question',
      ).toBe(true);
    } finally {
      infoHist.mockRestore();
    }
  });

  it('a backend without the real-count seam still dual-reports: realPromptTokens is null, the estimate remains (real-token-count)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const engine = makeEngine('fast', new BareBackend());
      attachDroppingSurface(engine);
      await engine.query(QUESTION, {});

      const record = tokenRecord(info);
      expect(record, 'unavailable real count must not suppress the record').toBeDefined();
      expect(record!.estimatedPromptTokens as number).toBeGreaterThan(0);
      expect(record!.realPromptTokens, 'no backend count -> explicit null (never a fabricated number)').toBeNull();
    } finally {
      info.mockRestore();
    }
  });
});
