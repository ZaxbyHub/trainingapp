/**
 * Shared chat types for the Document Q&A application.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

/** A rendered image attached to a chat message (preview only; no raw bytes). */
export interface ChatImage {
  id: string;
  /** Data URL used to render the thumbnail. */
  dataUrl: string;
  mimeType: string;
  fileName?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources?: string[];
  timestamp: number;
  isStreaming?: boolean;
  /** Images the user attached to this message (multimodal). */
  images?: ChatImage[];
}

export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}
