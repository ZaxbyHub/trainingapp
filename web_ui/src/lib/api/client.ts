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
 * Create headers object with auth token if available.
 */
function createHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * ApiClient provides typed methods for all FastAPI endpoints.
 */
export class ApiClient {
  private baseUrl: string;
  private token?: string;

  /**
   * Create a new ApiClient instance.
   * @param baseUrl - Base URL of the API server (defaults to same-origin)
   * @param token - Optional auth token to use for all requests
   */
  constructor(baseUrl: string = DEFAULT_BASE_URL, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  /**
   * Get the effective token (provided token or stored token).
   */
  private getEffectiveToken(): string | undefined {
    return this.token || getToken();
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/documents`, {
      method: 'GET',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

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

    const token = this.getEffectiveToken();
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/ingest`, {
      method: 'POST',
      headers: createHeaders(token),
      body: JSON.stringify({ directory }),
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/documents`, {
      method: 'DELETE',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const body: { question: string; n_results?: number } = { question };
    if (nResults !== undefined) {
      body.n_results = nResults;
    }

    const response = await fetch(`${this.baseUrl}/ask`, {
      method: 'POST',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'GET',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'PUT',
      headers: createHeaders(token),
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

    const token = this.getEffectiveToken();
    const response = await fetch(`${this.baseUrl}/stats`, {
      method: 'GET',
      headers: createHeaders(token),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await parseErrorResponse(response));
    }

    return response.json();
  }
}
