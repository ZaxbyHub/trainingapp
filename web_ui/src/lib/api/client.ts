/**
 * API Client for the FastAPI backend.
 * Provides typed methods for all endpoints with automatic token injection.
 */

import { ApiError, type ApiErrorResponse } from './types';
import type {
  ListDocumentsResponse,
  UploadFileResponse,
  UploadBatchResponse,
  IngestDirectoryResponse,
  DeleteDocumentsResponse,
  AskResponse,
  SearchResponse,
  SettingsUpdate,
  SettingsResponse,
  StatsResponse,
} from './types';
import { getToken } from './auth';

/**
 * Default base URL for the API server
 */
const DEFAULT_BASE_URL = '';

/**
 * Validate and normalize a directory path for ingestion.
 * Allows only relative same-origin paths; rejects absolute paths and traversal.
 */
export function sanitizeDirectoryPath(directory: string): string {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new ApiError(400, 'Invalid directory path');
  }

  let normalized = directory.replace(/\\/g, '/');

  // Reject absolute paths: Unix-style or Windows drive-style
  if (normalized.startsWith('/')) {
    throw new ApiError(400, 'Invalid directory path');
  }

  if (/^[a-zA-Z]:\//.test(normalized)) {
    throw new ApiError(400, 'Invalid directory path');
  }

  // Reject traversal sequences in any segment
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new ApiError(400, 'Invalid directory path');
    }
  }

  return normalized;
}

/**
 * Check if the browser is online.
 */
function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/**
 * Parse error response body for detail message.
 */
async function parseErrorResponse(response: Response): Promise<string> {
  try {
    const errorBody: ApiErrorResponse = await response.json();
    return errorBody.detail || `HTTP error: ${response.status}`;
  } catch {
    return `HTTP error: ${response.status}`;
  }
}

/**
 * ApiClient provides typed methods for all FastAPI endpoints.
 */
export class ApiClient {
  private baseUrl: string;
  private token?: string;
  private authHeaderName: string;

  /**
   * Create a new ApiClient instance.
   * @param baseUrl - Base URL of the API server (defaults to same-origin)
   * @param token - Optional auth token to use for all requests
   * @param authHeaderName - Optional auth header name carrying the bearer
   *   token; defaults to the Python backend's 'Authorization'. Electron mode
   *   passes the desktop loopback guard's 'X-Desktop-Token' (issue #67).
   */
  constructor(baseUrl: string = DEFAULT_BASE_URL, token?: string, authHeaderName?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.authHeaderName = authHeaderName ?? 'Authorization';
  }

  /**
   * Get the effective token (provided token or stored token).
   */
  private getEffectiveToken(): string | undefined {
    return this.token ?? getToken() ?? undefined;
  }

  /**
   * Build request headers with the token carried in THIS client's configured
   * auth header (issue #67). Replaces the module-level createHeaders for all
   * instance fetches so no site can regress to a hardcoded header name.
   */
  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = this.getEffectiveToken();
    if (token) {
      headers[this.authHeaderName] = this.authValue(token);
    }
    return headers;
  }

  /**
   * Multipart variant: same auth header, no Content-Type (the browser sets
   * the multipart boundary).
   */
  private multipartHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.getEffectiveToken();
    if (token) {
      headers[this.authHeaderName] = this.authValue(token);
    }
    return headers;
  }

  /**
   * Header VALUE scheme: the Python backend's Authorization header carries
   * `Bearer <token>`; the desktop guard's X-Desktop-Token is compared as the
   * RAW token (plain equality, issue #67).
   */
  private authValue(token: string): string {
    return this.authHeaderName === 'Authorization' ? `Bearer ${token}` : token;
  }

  /**
   * Document Operations
   */

  /**
   * List all documents in the system.
   * @returns Promise resolving to list of documents
   * @throws ApiError if the request fails
   */
  async listDocuments(): Promise<ListDocumentsResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/documents`, {
      method: 'GET',
      headers: this.requestHeaders(),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Upload a single file for ingestion.
   * @param file - The file to upload
   * @returns Promise resolving to upload result
   * @throws ApiError if the request fails
   */
  async uploadFile(file: File): Promise<UploadFileResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const formData = new FormData();
    formData.append('file', file);

    const headers = this.multipartHeaders();

    const response = await fetch(`${this.baseUrl}/ingest/file`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Upload multiple files for batch ingestion.
   * @param files - Array of files to upload
   * @returns Promise resolving to batch upload result
   * @throws ApiError if the request fails
   */
  async uploadBatch(files: File[]): Promise<UploadBatchResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    const headers = this.multipartHeaders();

    const response = await fetch(`${this.baseUrl}/ingest/batch`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Ingest all files from a directory.
   * @param directory - Path to the directory to ingest
   * @returns Promise resolving to ingest result
   * @throws ApiError if the request fails
   */
  async ingestDirectory(directory: string): Promise<IngestDirectoryResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const sanitized = sanitizeDirectoryPath(directory);

    const response = await fetch(`${this.baseUrl}/ingest`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({ directory: sanitized }),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Clear all documents from the system.
   * @returns Promise resolving to delete status
   * @throws ApiError if the request fails
   */
  async clearDocuments(): Promise<DeleteDocumentsResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/documents`, {
      method: 'DELETE',
      headers: this.requestHeaders(),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Question Operations
   */

  /**
   * Ask a question and get a response.
   * @param question - The question to ask
   * @param nResults - Optional number of results to return
   * @returns Promise resolving to the answer
   * @throws ApiError if the request fails
   */
  async ask(question: string, nResults?: number): Promise<AskResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const body: { question: string; n_results?: number } = { question };
    if (nResults !== undefined) {
      body.n_results = nResults;
    }

    const response = await fetch(`${this.baseUrl}/ask`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Search for relevant documents.
   * @param query - The search query
   * @param nResults - Number of results to return
   * @returns Promise resolving to search results
   * @throws ApiError if the request fails
   */
  async search(query: string, nResults: number = 5): Promise<SearchResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({ query, n_results: nResults }),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Settings Operations
   */

  /**
   * Get current settings.
   * @returns Promise resolving to current settings
   * @throws ApiError if the request fails
   */
  async getSettings(): Promise<SettingsResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'GET',
      headers: this.requestHeaders(),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Update settings with partial update.
   * @param partial - Partial settings object to update
   * @returns Promise resolving to updated settings
   * @throws ApiError if the request fails
   */
  async updateSettings(partial: SettingsUpdate): Promise<SettingsResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'PUT',
      headers: this.requestHeaders(),
      body: JSON.stringify(partial),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }

  /**
   * Stats Operations
   */

  /**
   * Get system statistics.
   * @returns Promise resolving to system stats
   * @throws ApiError if the request fails
   */
  async getStats(): Promise<StatsResponse> {
    if (!isOnline()) {
      throw new ApiError(0, 'Network unavailable. Please check your connection.');
    }

    const response = await fetch(`${this.baseUrl}/stats`, {
      method: 'GET',
      headers: this.requestHeaders(),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }
}
