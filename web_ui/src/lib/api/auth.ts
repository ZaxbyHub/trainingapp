/**
 * Authentication functions for API token management.
 * Handles token storage, retrieval, and auth status checks.
 */

import { ApiError, type TokenResponse, type AuthStatusResponse } from './types';

const TOKEN_KEY = 'doc_qa_access_token';

/**
 * Store the access token in sessionStorage.
 * Wrapped in try/catch for Safari private mode compatibility.
 */
export function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // sessionStorage unavailable (e.g., Safari private mode)
  }
}

/**
 * Retrieve the stored access token from sessionStorage.
 * @returns The token string or null if not found/unavailable
 */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // sessionStorage unavailable
    return null;
  }
}

/**
 * Clear the stored access token from sessionStorage.
 */
export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

/**
 * Login with an API key and store the resulting access token.
 * @param apiKey - The API key to authenticate with
 * @returns Promise resolving to the token response
 * @throws ApiError if authentication fails
 */
export async function login(apiKey: string): Promise<TokenResponse> {
  const response = await fetch('/auth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ detail: 'Authentication failed' }));
    throw new ApiError(response.status, errorBody.detail || 'Authentication failed');
  }

  const data: TokenResponse = await response.json();
  storeToken(data.access_token);
  return data;
}

/**
 * Get the current authentication status.
 * @returns Promise resolving to auth status response
 * @throws ApiError if the request fails
 */
export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const response = await fetch('/auth/status');

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ detail: 'Failed to get auth status' }));
    throw new ApiError(response.status, errorBody.detail || 'Failed to get auth status');
  }

  return response.json();
}
