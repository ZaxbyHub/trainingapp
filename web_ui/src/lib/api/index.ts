/**
 * API Client Layer
 * Exports all API types, client classes, and auth functions.
 */

import { ApiClient } from './client';

export { ApiClient };
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
 * Default client instance using same-origin requests.
 *
 * Same-origin + Authorization dialect ONLY — this instance is for the pure
 * browser / remote-Python-server modes. Inside Electron, consumers MUST use
 * the desktop session's client (web_ui/src/lib/desktop-session.tsx), which
 * targets the loopback backend with the raw-token X-Desktop-Token header.
 */
export const apiClient = new ApiClient('');
