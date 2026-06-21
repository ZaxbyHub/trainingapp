/**
 * Pure helpers for chat message-array operations (testable without React).
 */

import type { ChatMessage } from '../../types/chat';

/**
 * Compute the message array for a "regenerate" action: drop the trailing
 * assistant/system messages that follow the most recent user message, then
 * append a fresh assistant placeholder. The user message (and any earlier
 * history, including a leading 'hidden-messages-indicator') is preserved.
 *
 * If there is no user message, returns the kept history with the placeholder
 * appended (caller should gate on there being a regenerable turn).
 */
export function messagesForRegenerate(
  messages: ChatMessage[],
  assistantPlaceholder: ChatMessage
): ChatMessage[] {
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') break;
    cut = i;
  }
  return [...messages.slice(0, cut), assistantPlaceholder];
}
