// Issue #157: token-based budget for the desktop local RAG prompt — the
// desktop port of the browser's F11 reserved-token budget
// (web_ui/src/lib/rag/rag-orchestrator.ts:483-520) plus the token-capped
// history the unmerged PR #48 review recommended porting forward
// (capHistoryBudget at 2b6af91). Pure functions only; the single source of
// truth for the context window lives here and llama-engine re-exports it.

/** The context window the desktop engine creates the model context with.
 *  Single source of truth (previously declared in llama-engine.ts; the parity
 *  comment travels with it): DEFAULT_N_CTX parity
 *  (web_ui/src/lib/llm/wllama-service.ts). */
export const CONTEXT_SIZE = 8192;

/** Browser-parity chars-per-token estimate (rag-orchestrator F11). No
 *  tokenizer handle exists in the main process before model load, so the
 *  budget is deterministic on characters; the safety margin below covers the
 *  estimation error and chat-template control tokens. */
export const CHARS_PER_TOKEN = 4;

/** PR #48 prior-art value: the history channel may consume at most this many
 *  estimated tokens (8192 chars joined), so one conversation channel can
 *  never collapse the whole grounded-context budget. */
export const MAX_HISTORY_BUDGET_TOKENS = 2048;

/** Reserved for estimation error + chat-template control tokens. Together
 *  with the per-profile answer budget this is what keeps the assembled prompt
 *  under CONTEXT_SIZE; the explicit per-channel estimates in
 *  groundedContextBudgetChars are deliberate ADDITIONAL conservatism on top
 *  (the margin already covers them) — documented so the constants are not
 *  "double-shrunk" later. Phase 4.5 mutation target. */
export const SAFETY_MARGIN_TOKENS = 512;

/** A contract history turn as it arrives on EngineQueryOptions.history. */
export interface HistoryTurn {
  role: unknown;
  content: unknown;
}

/**
 * Token-cap a conversation history: drop oldest WHOLE turns until the joined
 * text fits `maxChars`; always keep >= 1 turn; after the drop loop re-anchor
 * user-first (a leading assistant turn is orphaned context with no preceding
 * user turn — same rule as the browser's history-snapshot window); precedence:
 * keep->=1-turn WINS over the re-anchor drop, so a lone surviving assistant
 * turn stays; a lone surviving oversized turn is tail-truncated to fit (keeps
 * the most recent content, the most relevant for follow-ups).
 *
 * No-op passthrough (same array contents and order) when the joined text
 * already fits — within-budget histories must stay byte-identical to base,
 * including assistant-first in-budget windows (re-anchoring those would be a
 * behavior change, so the re-anchor only ever runs after a drop).
 *
 * The ORDER of cap-then-turn-slice at the call site is LOAD-BEARING for the
 * user-first re-anchor: with 13 alternating 680-char turns vs an 8,192-char
 * budget, cap-then-slice drops the oldest turn and re-anchors user-first,
 * while slice-then-cap lets the turn cap no-op the drop so the char cap never
 * fires, no re-anchor runs, and an assistant-first window seeds.
 */
export function capHistoryTokens<T extends HistoryTurn>(history: T[], maxChars: number): T[] {
  const joinedLength = (turns: T[]): number =>
    turns.reduce((total, turn, i) => total + String(turn.content ?? '').length + (i > 0 ? 1 : 0), 0);
  if (history.length === 0 || joinedLength(history) <= maxChars) return history;
  // Drop oldest whole turns until the remaining text fits (keep >= 1).
  let kept = history.slice();
  while (kept.length > 1 && joinedLength(kept) > maxChars) {
    kept = kept.slice(1);
  }
  // Re-anchor user-first AFTER the drop loop (see doc comment).
  while (kept.length > 1 && kept[0]!.role !== 'user') {
    kept = kept.slice(1);
  }
  // A single over-budget survivor is tail-truncated to fit. PRR-015: guard
  // maxChars <= 0 (JS slice(-0) returns the FULL string — the truncation
  // would silently no-op at a degenerate bound) and trim on a code-point
  // boundary so the cut cannot emit a lone surrogate.
  const lone = kept.length === 1 ? kept[0]! : null;
  if (lone !== null && String(lone.content ?? '').length > maxChars) {
    let content = maxChars > 0 ? String(lone.content ?? '').slice(-maxChars) : '';
    if (content.length > 0) {
      const last = content.charCodeAt(content.length - 1);
      // A high surrogate (0xD800-0xDBFF) with no following low surrogate is a
      // split pair — drop it.
      if (last >= 0xd800 && last <= 0xdbff) content = content.slice(0, -1);
    }
    kept = [{ ...lone, content } as T];
  }
  return kept;
}

/** CJK (Han, Hiragana, Katakana, Hangul, CJK Ext A + compat) code-point
 *  ranges. Issue #157 PR-review PRR-001: BPE tokenizers encode CJK at
 *  ~1.4-2 chars/token (best case) — the 4 chars/token Latin average
 *  under-counts this class ~2-6x, which would defeat the window bound on the
 *  CJK corpora the ingest pipeline deliberately supports (text-chunker's
 *  isCjkDense). */
const CJK_RANGE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ｦ-ﾟ]/;

/**
 * Estimated tokens for a string: CJK code points are charged ONE token each
 * (a conservative upper bound — real Chinese tokenizers average ~0.5-0.7
 * tokens/char), everything else at CHARS_PER_TOKEN. Over-estimating only
 * tightens the ceiling (safe direction for a budget).
 *
 * (The single-number `estimateTokens(chars)` form was replaced here; the only
 * callers pass the actual prompt-channel strings.)
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (CJK_RANGE.test(text[i]!)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / CHARS_PER_TOKEN);
}

/**
 * The grounded-context char budget: what remains of the context window after
 * reserving the answer budget, the safety margin, and estimates for every
 * other prompt channel (system prompt, grounded instruction, question, and
 * the CAPPED history text — the estimate must never under-count what seeding
 * actually places in the window). The `truncationChars` ceiling (the wired
 * rag_context_truncation setting) can only TIGHTEN the derived bound, never
 * loosen it: min(derived, setting). The min direction is a Phase 4.5
 * mutation target.
 */
export function groundedContextBudgetChars(inputs: {
  answerTokens: number;
  systemPrompt: string;
  groundedInstruction: string;
  question: string;
  cappedHistoryText: string;
  truncationChars?: number;
}): number {
  const reserved =
    inputs.answerTokens +
    SAFETY_MARGIN_TOKENS +
    estimateTokens(inputs.systemPrompt + inputs.groundedInstruction + inputs.question + inputs.cappedHistoryText);
  const derived = Math.max(0, CONTEXT_SIZE - reserved) * CHARS_PER_TOKEN;
  return inputs.truncationChars === undefined ? derived : Math.min(derived, inputs.truncationChars);
}

/**
 * How many leading rows of `texts` fit `budgetChars` as the grounded
 * assembly (`[n] text` blocks joined by blank lines — the numbering and
 * joiners are charged to the budget). Returns the survivor count; callers
 * derive every downstream field (texts/sources/contextLength/cited) from the
 * surviving rows so provenance stays consistent when rows drop. Never
 * truncates mid-row; 0 is a valid answer (the grounding logic downstream
 * already resolves an empty evidence set to 'general').
 */
export function countRowsWithinBudget(texts: string[], budgetChars: number): number {
  let used = 0;
  let count = 0;
  for (const text of texts) {
    // '[n] ' prefix (up to two digits in practice) + '\n\n' joiner.
    const overhead = `[${count + 1}] `.length + (count > 0 ? 2 : 0);
    if (used + overhead + text.length > budgetChars) break;
    used += overhead + text.length;
    count += 1;
  }
  return count;
}
