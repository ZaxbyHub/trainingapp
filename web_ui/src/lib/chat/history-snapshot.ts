/**
 * Issue #40 RC1: build the conversation-history snapshot threaded into the RAG
 * orchestrator (browser mode) and the desktop backend's /ask/stream POST body
 * (desktop api mode).
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
 * F-012: the ONLY assistant-turn shape Direct chat may thread — tagged
 * 'general' AND showing no sources and no citations. Length checks, not
 * truthiness: a desktop Direct answer arrives with `sources: []` and
 * `citations: []`, which must still count as "no sources".
 */
function isSourcelessGeneralAnswer(m: ChatMessage): boolean {
  return m.grounding === 'general' && (m.sources?.length ?? 0) === 0 && (m.citations?.length ?? 0) === 0;
}

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
 *
 * F-012 (PR #142 review): `excludeGrounded` (set by the browser's ungrounded
 * Direct chat, and by the desktop snapshot below when the backend answers
 * with an external model in Direct chat) filters assistant turns FAIL CLOSED:
 * an answer built from retrieved document passages must not ride into a turn
 * the user chose to send WITHOUT retrieval (it may have been produced by the
 * local engine and never left the device). Only assistant turns tagged
 * 'general' that carry no sources or citations thread; untagged turns (an
 * answer Stopped mid-stream, legacy turns) and any answer that showed sources
 * (the desktop backend tags rerank-off answers 'general' even when passages
 * were used) are dropped (fail closed). A dropped answer's question is then
 * dropped by rule 4 / the trailing-user rule below.
 */
export function buildHistorySnapshot(
  owningMessages: ChatMessage[],
  opts?: { excludeGrounded?: boolean },
): RAGHistoryTurn[] {
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
  // 3. Keep only substantive turns (F-012: and, for Direct chat, only
  // 'general' answers that showed no sources or citations — fail closed).
  const substantive = trimmed.filter(
    (m) =>
      m.role === 'user' ||
      (m.role === 'assistant' &&
        !m.error &&
        !m.abstain &&
        (m.content ?? '').trim().length > 0 &&
        !(opts?.excludeGrounded === true && !isSourcelessGeneralAnswer(m)))
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
  // F-004 (PR #138 review): a trailing user turn means the PREVIOUS assistant
  // turn was dropped (error / abstain / empty card) or never happened — and
  // the caller is about to append the CURRENT user turn, so sending this one
  // would put two consecutive `user` messages on the wire. Third-party jinja
  // chat templates (llama-server --jinja, LM Studio Gemma/Mistral templates)
  // can reject that shape outright, wedging the conversation until New Chat
  // (Try-again cannot recover it). An unanswered question carries no answer
  // context, so drop trailing user turns instead of sending them.
  while (windowed.length > 0 && windowed[windowed.length - 1].role === 'user') {
    windowed = windowed.slice(0, -1);
  }
  return windowed.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content ?? '',
  }));
}

/**
 * F-012 (PR #142 Stage B): the desktop backend's /ask/stream history carries
 * no grounding tag, so the backend cannot drop retrieval-grounded answers
 * itself. The renderer decides from the backend's OWN settings, read fresh at
 * send time: the fail-closed filter (only sourceless 'general' answers
 * thread; see buildHistorySnapshot) applies when the backend will answer with
 * an external model in Direct chat (external.enabled with a base URL and a
 * model, and external.grounded not true). When the settings cannot be read
 * the answer is fail-closed: exclude (a grounded follow-up then loses some
 * conversational context; nothing grounded can leave the device by mistake).
 */
export function desktopSettingsExcludeGrounded(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return true;
  const s = settings as Record<string, unknown>;
  if (typeof s['external.enabled'] !== 'boolean') return true;
  const externalActive =
    s['external.enabled'] === true &&
    typeof s['external.baseUrl'] === 'string' &&
    s['external.baseUrl'] !== '' &&
    typeof s['external.model'] === 'string' &&
    s['external.model'] !== '';
  return externalActive && s['external.grounded'] !== true;
}

/**
 * F-012: the history snapshot for a desktop /ask/stream request. Reads the
 * backend settings (GET /settings) once per send; any failure — no client,
 * a rejected request, a malformed answer — excludes grounded answers.
 */
export async function buildDesktopHistorySnapshot(
  apiClient: { getSettings?: () => Promise<unknown> } | null | undefined,
  owningMessages: ChatMessage[],
): Promise<RAGHistoryTurn[]> {
  let excludeGrounded = true;
  try {
    if (apiClient !== null && apiClient !== undefined && typeof apiClient.getSettings === 'function') {
      excludeGrounded = desktopSettingsExcludeGrounded(await apiClient.getSettings());
    }
  } catch {
    excludeGrounded = true;
  }
  return buildHistorySnapshot(owningMessages, { excludeGrounded });
}
