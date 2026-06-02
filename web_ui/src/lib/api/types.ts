/**
 * TypeScript interfaces matching FastAPI backend request/response shapes.
 * All field names use snake_case to match the Python backend.
 */

/**
 * Auth Types
 */
export interface TokenRequest {
  api_key: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}

export interface AuthStatusResponse {
  enabled: boolean;
  auth_required: boolean;
  method: string;
}

/**
 * Document Types
 */
export interface DocumentInfo {
  id: string;
  chunk_count: number;
}

export interface ListDocumentsResponse {
  documents: DocumentInfo[];
  total: number;
}

export interface UploadFileResponse {
  success: boolean;
  documents: number;
  chunks_added: number;
  message?: string;
}

export interface BatchFileResult {
  filename: string;
  success: boolean;
  chunks_added: number;
  error?: string;
}

export interface UploadBatchResponse {
  total_files: number;
  successful: number;
  failed: number;
  results: BatchFileResult[];
}

export interface IngestDirectoryResponse {
  success: boolean;
  documents: number;
  chunks_added: number;
  message?: string;
}

export interface DeleteDocumentsResponse {
  status: string;
}

/**
 * Question Types
 */
export interface AskRequest {
  question: string;
  n_results?: number;
}

export interface AskResponse {
  question: string;
  answer: string;
  sources: string[];
  context_length: number;
  inference_time: number;
}

export interface SearchRequest {
  query: string;
  n_results: number;
}

export interface SearchResult {
  text: string;
  source: string;
  similarity: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

/**
 * Settings Types
 */
export interface SettingsUpdate {
  chunk_size?: number;
  chunk_overlap?: number;
  n_results?: number;
  embedding_model?: string;
  llm_backend?: string;
  [key: string]: unknown;
}

export interface SettingsResponse {
  chunk_size: number;
  chunk_overlap: number;
  n_results: number;
  embedding_model: string;
  llm_backend?: string;
  [key: string]: unknown;
}

/**
 * Stats Types
 */
export interface StatsResponse {
  document_count: number;
  chunk_count: number;
  embedding_model: string;
  llm_backend?: string;
  documents: string[];
}

/**
 * Error Types
 */
export interface ApiErrorResponse {
  detail: string;
}

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * SSE Stream Types
 */
export interface StreamTokenEvent {
  token: string;
}

export interface StreamDoneEvent {
  sources: string[];
  context_length: number;
  inference_time: number;
}
