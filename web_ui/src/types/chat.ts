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

/** Structured, per-chunk citation reference rendered as a numbered pill (F7). */
export interface CitationRef {
  docId: string;
  chunkIndex: number;
  /** Filename of the source document. */
  source?: string;
  /** Page number within the source document, when known. */
  page?: number;
  /** Chunk text (or a snippet) shown on click-through. */
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Source filenames (legacy render path; kept for backward compatibility). */
  sources?: string[];
  /** Structured numbered citations, aligned with the model's [1],[2] order (F7). */
  citations?: CitationRef[];
  /** True when the pipeline abstained (no usable evidence) instead of answering (F2). */
  abstain?: boolean;
  /** Why the pipeline abstained. */
  abstainReason?: 'insufficient_evidence' | 'retrieval_degraded';
  /** True when retrieval ran keyword-only because semantic search was unavailable (F4). */
  retrievalDegraded?: boolean;
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
