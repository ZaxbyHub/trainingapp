/**
 * Issue #40 RC1: build the conversation-history snapshot threaded into the RAG
 * orchestrator (browser mode) and the /ask/stream POST body (server mode).
 *
 * Extracted from ChatPage into a pure module so it is unit-testable without a
 * React rendering harness. Pure: given a ChatMessage[] snapshot captured at
 * send time, return the prior user/assistant turns as {role, content} pairs.
 */

import type { ChatMessage } from '../../types/chat';
import type { RAGHistoryTurn } from '../rag/rag-orchestrator';

/**
 * Maximum number of prior turns to thread into the LLM prompt / retrieval
 * contextualizer. Capped to bound token-budget impact (the orchestrator also
 * charges history to the budget, but capping here keeps the snapshot small and
 * matches the orchestrator's reservation math). ~3 user/assistant exchanges.
 */
export const MAX_HISTORY_TURNS = 6;

/**
 * Build the conversation-history snapshot for the orchestrator / server.
 *
 * `owningMessages` (the snapshot captured at send time) INCLUDES the current
 * user turn and a trailing empty assistant placeholder. This helper drops both
 * and returns the prior user/assistant turns as {role, content} pairs the LLM
 * chat-template and the retrieval-contextualizing heuristic consume.
 *
 * Filtering rules (in order):
 *  1. drop trailing empty assistant placeholder(s) (the current turn in flight);
 *  2. drop the just-added user message (the orchestrator gets `text` separately);
 *  3. keep only substantive turns — ALL user turns are kept (even empty ones,
 *     since an empty user turn is rare and the caller already trimmed the
 *     current one); assistant turns are kept only when they have content AND are
 *     not error/abstention cards;
 *  4. enforce role alternation — collapse consecutive same-role turns by keeping
 *     only the last, so the chat template always sees user/assistant/user/...;
 *  5. cap at the last MAX_HISTORY_TURNS messages (oldest truncated first).
 */
export function buildHistorySnapshot(owningMessages: ChatMessage[]): RAGHistoryTurn[] {
  if (!Array.isArray(owningMessages) || owningMessages.length === 0) return [];
  const trimmed = owningMessages.slice();
  // 1. Drop trailing empty assistant placeholder(s) (the current turn in flight).
  while (
    trimmed.length > 0 &&
    trimmed[trimmed.length - 1].role === 'assistant' &&
    !(trimmed[trimmed.length - 1].content ?? '').trim()
  ) {
    trimmed.pop();
  }
  // 2. Drop the just-added user message (the orchestrator gets `text` separately).
  if (trimmed.length > 0 && trimmed[trimmed.length - 1].role === 'user') {
    trimmed.pop();
  }
  // 3. Keep only substantive turns.
  const substantive = trimmed.filter(
    (m) =>
      m.role === 'user' ||
      (m.role === 'assistant' && !m.error && !m.abstain && (m.content ?? '').trim().length > 0)
  );
  // 4. Enforce role alternation: collapse consecutive same-role turns (keep last).
  const alternating: ChatMessage[] = [];
  for (const m of substantive) {
    if (alternating.length > 0 && alternating[alternating.length - 1].role === m.role) {
      alternating[alternating.length - 1] = m; // replace
    } else {
      alternating.push(m);
    }
  }
  // 5. Cap at the last MAX_HISTORY_TURNS (oldest truncated first).
  let windowed = alternating.slice(-MAX_HISTORY_TURNS);
  // PRR-001: when the cap splits mid-conversation, slice(-N) can land on an
  // assistant-first window (e.g. [u,a,u,a,u,a,u].slice(-6) = [a,u,a,u,a,u]).
  // A leading assistant turn is orphaned context — it has no preceding user
  // turn in the window — and, under the Gemma 4 chat-template override, it
  // also mis-targets `loop.first` so a `system_prefix` kwarg would be silently
  // dropped (the assistant branch has no prefix handling). Drop a leading
  // assistant turn so the window always opens user-first.
  while (windowed.length > 1 && windowed[0].role === 'assistant') {
    windowed = windowed.slice(1);
  }
  return windowed.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content ?? '',
  }));
}
