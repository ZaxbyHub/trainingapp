/**
 * Conversation export — serialize a chat to JSON or Markdown and download it.
 * Lets users keep a record of an answer + its sources (the offline app stores
 * nothing remotely).
 */

import type { ChatMessage } from '../../types/chat';

/** Stable, documented JSON shape for an exported conversation. */
export interface ConversationExport {
  exportedAt: string;
  version: 1;
  messages: Array<{
    role: ChatMessage['role'];
    content: string;
    timestamp: number;
    sources?: string[];
    images?: Array<{ fileName?: string; mimeType: string }>;
  }>;
}

/** Build the JSON export object (image bytes are omitted; only metadata kept). */
export function toConversationExport(messages: ChatMessage[]): ConversationExport {
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.sources && m.sources.length ? { sources: m.sources } : {}),
        ...(m.images && m.images.length
          ? { images: m.images.map((i) => ({ fileName: i.fileName, mimeType: i.mimeType })) }
          : {}),
      })),
  };
}

export function exportAsJSON(messages: ChatMessage[]): string {
  return JSON.stringify(toConversationExport(messages), null, 2);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Render the conversation as readable Markdown with sources. */
export function exportAsMarkdown(messages: ChatMessage[]): string {
  const lines: string[] = ['# Conversation', '', `_Exported ${new Date().toLocaleString()}_`, ''];

  for (const m of messages) {
    if (m.role === 'system') continue;
    const who = m.role === 'user' ? '## You' : '## Assistant';
    lines.push(who, '');
    lines.push(m.content.trim() || '_(empty)_', '');

    if (m.images && m.images.length) {
      lines.push(`_Attached: ${m.images.map((i) => i.fileName || i.mimeType).join(', ')}_`, '');
    }
    if (m.role === 'assistant' && m.sources && m.sources.length) {
      lines.push('**Sources:**');
      for (const s of m.sources) lines.push(`- ${basename(s)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Trigger a browser download of text content. No-op outside a DOM.
 */
export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL on the next tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Convenience: export the conversation and download it in the chosen format. */
export function downloadConversation(messages: ChatMessage[], format: 'json' | 'markdown'): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'json') {
    downloadTextFile(exportAsJSON(messages), `conversation-${stamp}.json`, 'application/json');
  } else {
    downloadTextFile(exportAsMarkdown(messages), `conversation-${stamp}.md`, 'text/markdown');
  }
}
