/**
 * API Client Layer
 * Exports all API types, client classes, and auth functions.
 */

export { ApiClient } from './client';
export { SSEStreamConsumer } from './streaming';
export { login, getAuthStatus, getToken, clearToken, storeToken } from './auth';

export type {
  TokenResponse,
  AuthStatusResponse,
  ListDocumentsResponse,
  DocumentInfo,
  UploadFileResponse,
  BatchFileResult,
  UploadBatchResponse,
  IngestDirectoryResponse,
  DeleteDocumentsResponse,
  AskRequest,
  AskResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SettingsUpdate,
  SettingsResponse,
  StatsResponse,
  ApiErrorResponse,
  StreamTokenEvent,
  StreamDoneEvent,
} from './types';

export { ApiError } from './types';

/**
 * Default client instance using same-origin requests
 */
export const apiClient = new ApiClient('');
