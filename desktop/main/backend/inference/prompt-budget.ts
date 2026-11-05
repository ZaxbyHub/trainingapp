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
  // would silently no-op at a degenerate bound) and trim on code-point
  // boundaries: the CUT START is the split hazard (a maxChars landing inside
  // a surrogate pair leaves a lone LOW surrogate first), and the tail is
  // defensively stripped of an unpaired HIGH surrogate.
  const lone = kept.length === 1 ? kept[0]! : null;
  if (lone !== null && String(lone.content ?? '').length > maxChars) {
    let content = maxChars > 0 ? String(lone.content ?? '').slice(-maxChars) : '';
    if (content.length > 0) {
      const first = content.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) content = content.slice(1);
      const last = content.charCodeAt(content.length - 1);
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
 * Issue #280 (C1): token-cap a conversation history by ESTIMATED tokens
 * instead of the raw character count the Latin-average capHistoryTokens
 * measures with. CJK text is where the two diverge: BPE tokenizers encode
 * Han/Hiragana/Katakana/Hangul at ~1.4-2 chars/token, so an 8,192-CHAR
 * budget holds ~2,048 Latin tokens but up to ~8,192 CJK tokens — four times
 * what MAX_HISTORY_BUDGET_TOKENS reserves — and the char-capped history then
 * overflows the window reservation it was budgeted for.
 *
 * CJK-free histories (one CJK_RANGE scan over the newline-joined text)
 * delegate to capHistoryTokens(turns, tokenBudget * CHARS_PER_TOKEN): the
 * 4-chars/token average is the exact model for that class, and the delegated
 * call returns the identical kept array (re-anchor and lone-turn truncation
 * included), so Latin behavior is byte-identical to the pre-#280 cap.
 *
 * When ANY CJK character is present, turns are measured with
 * estimateTokens — drop oldest WHOLE turns until BOTH (a) the per-turn sum
 * of estimateTokens(turn.content) AND (b) estimateTokens of the
 * newline-JOINED kept contents are within tokenBudget. Both bounds are
 * needed: per-turn ceil rounding under-counts the joined text (a history can
 * pass (a) while its single joined estimate — what the window reservation
 * actually charges — exceeds the budget), and (b) alone would admit a
 * history whose individual turns overflow when only the joiner is charged
 * once. Then the same re-anchor user-first rule as the character cap, and a
 * lone surviving over-budget turn is tail-truncated on a token-aware,
 * surrogate-safe boundary (the cut start never splits a surrogate pair; the
 * truncated turn's direct estimate is within the budget by construction —
 * the estimate is monotonically non-decreasing as the kept suffix grows, so
 * the longest fitting suffix is exact).
 */
export function capHistoryByEstimatedTokens<T extends HistoryTurn>(history: T[], tokenBudget: number): T[] {
  const joinedText = history.map((turn) => String(turn.content ?? '')).join('\n');
  if (!CJK_RANGE.test(joinedText)) {
    return capHistoryTokens(history, tokenBudget * CHARS_PER_TOKEN);
  }
  const contentOf = (turn: T): string => String(turn.content ?? '');
  const perTurnSum = (turns: T[]): number => turns.reduce((total, turn) => total + estimateTokens(contentOf(turn)), 0);
  const joinedEstimate = (turns: T[]): number => estimateTokens(turns.map(contentOf).join('\n'));
  if (history.length === 0 || (perTurnSum(history) <= tokenBudget && joinedEstimate(history) <= tokenBudget)) {
    return history;
  }
  // Drop oldest whole turns until BOTH bounds fit (keep >= 1).
  let kept = history.slice();
  while (kept.length > 1 && (perTurnSum(kept) > tokenBudget || joinedEstimate(kept) > tokenBudget)) {
    kept = kept.slice(1);
  }
  // Re-anchor user-first AFTER the drop loop (same rule as the character cap:
  // a leading assistant turn is orphaned context; keep->=1 wins over the
  // re-anchor drop).
  while (kept.length > 1 && kept[0]!.role !== 'user') {
    kept = kept.slice(1);
  }
  // A single over-budget survivor is tail-truncated to the longest suffix
  // whose direct estimate fits. The walk grows the suffix one UTF-16 unit at
  // a time from the end (estimateTokens is monotone in that growth, so the
  // first exceed marks the exact boundary). Surrogate safety: the CUT START
  // is the split hazard — a cut landing on a LOW surrogate would open the
  // kept text with its orphaned half, so it is skipped, and a trailing
  // unpaired HIGH surrogate is defensively stripped.
  const lone = kept.length === 1 ? kept[0]! : null;
  if (lone !== null && estimateTokens(contentOf(lone)) > tokenBudget) {
    const content = contentOf(lone);
    let len = 0;
    let cjk = 0;
    let cutStart = content.length;
    for (let i = content.length - 1; i >= 0; i -= 1) {
      len += 1;
      if (CJK_RANGE.test(content[i]!)) cjk += 1;
      if (cjk + Math.ceil((len - cjk) / CHARS_PER_TOKEN) > tokenBudget) break;
      cutStart = i;
    }
    let truncated = cutStart > 0 ? content.slice(cutStart) : '';
    if (truncated.length > 0) {
      const first = truncated.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) truncated = truncated.slice(1);
      const last = truncated.charCodeAt(truncated.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
    }
    kept = [{ ...lone, content: truncated } as T];
  }
  return kept;
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
