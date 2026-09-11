/**
 * Electron-aware renderer session (issue #67, B9).
 *
 * Discovery + identity for running INSIDE the Electron shell:
 *   - isElectron(): `window.desktopApi` presence — the ONLY reliable signal,
 *     valid in both the packaged app:// renderer and the dev vite server.
 *     `location.protocol === 'app:'` fails in dev; user-agent sniffing is
 *     spoofable and useless here.
 *   - initDesktopSession(): awaits the preload bridge ONCE per boot (loopback
 *     port + launch token rotate on every app start, so nothing may be
 *     cached across launches) and builds the ApiClient + SSE accessor that
 *     speak the desktop guard's dialect (`X-Desktop-Token`).
 *   - DesktopSessionProvider/useDesktopSession(): React context so pages
 *     (Documents/Settings/Chat) consume the session without prop drilling.
 *     App gates mounting on init completing under the existing boot overlay.
 *
 * Pure-browser behavior is untouched: when `desktopApi` is absent every
 * helper here is inert and callers fall back to today's code paths.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ApiClient } from './api';
import type { ModelStatus } from './api/types';

import type { DesktopApiBridge } from '../types/desktop';
export type { DesktopApiBridge };

/** True only when running inside the Electron shell (preload bridge present). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.desktopApi !== 'undefined';
}

export class DesktopSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopSessionError';
  }
}

export interface DesktopSession {
  /** Loopback base URL of the Electron-hosted backend, e.g. http://127.0.0.1:PORT */
  baseUrl: string;
  /** Per-launch transport token (desktop guard: X-Desktop-Token header). */
  token: string;
  /** Backend mode from the frozen BackendHandle (e.g. 'node'). */
  mode: string;
  /** ApiClient bound to baseUrl + token + X-Desktop-Token. */
  apiClient: ApiClient;
  /** Absolute SSE endpoint for /ask/stream with this session. */
  sseUrl(): string;
}

let sessionPromise: Promise<DesktopSession> | null = null;

/** Reset memoized boot state (tests only). */
export function resetDesktopSessionForTests(): void {
  sessionPromise = null;
}

/**
 * Discover the backend once per launch. Rejects with DesktopSessionError when
 * not running inside Electron or when the bridge fails — App renders an
 * informative error state in that case instead of a silently broken app.
 */
export function initDesktopSession(): Promise<DesktopSession> {
  if (!isElectron()) {
    return Promise.reject(
      new DesktopSessionError(
        'Desktop bridge not found: this build must run inside the trainingapp desktop app.',
      ),
    );
  }
  if (sessionPromise) return sessionPromise;
  const desktopApi = window.desktopApi as DesktopApiBridge;
  sessionPromise = (async () => {
    try {
      const [backend, token] = await Promise.all([desktopApi.getBackendInfo(), desktopApi.getAuthToken()]);
      if (!backend?.url || !token) {
        throw new DesktopSessionError('Desktop backend reported no address; restart the app.');
      }
      const baseUrl = backend.url.replace(/\/$/, '');
      const apiClient = new ApiClient(baseUrl, token, 'X-Desktop-Token');
      return {
        baseUrl,
        token,
        mode: backend.mode ?? 'node',
        apiClient,
        sseUrl: () => `${baseUrl}/ask/stream`,
      } satisfies DesktopSession;
    } catch (err) {
      sessionPromise = null; // a failed launch must be retryable
      throw err instanceof DesktopSessionError
        ? err
        : new DesktopSessionError(
            `Could not reach the desktop backend: ${err instanceof Error ? err.message : String(err)}`,
          );
    }
  })();
  return sessionPromise;
}

export interface DesktopSessionState {
  session: DesktopSession | null;
  /** GET /status/models payload (AC5 first-run gate). */
  models: ModelStatus | null;
  /** True while the boot gate is still resolving. */
  loading: boolean;
  /** Informative boot failure (bridge missing/rejected). */
  error: string | null;
}

const DesktopSessionContext = createContext<DesktopSessionState>({
  session: null,
  models: null,
  loading: false,
  error: null,
});

export function DesktopSessionProvider({
  value,
  children,
}: {
  value: DesktopSessionState;
  children: ReactNode;
}) {
  const memo = useMemo(() => value, [value]);
  return <DesktopSessionContext.Provider value={memo}>{children}</DesktopSessionContext.Provider>;
}

export function useDesktopSession(): DesktopSessionState {
  return useContext(DesktopSessionContext);
}

/** Fetch GET /status/models over the desktop session (X-Desktop-Token). */
export async function fetchModelStatus(session: DesktopSession): Promise<ModelStatus> {
  const response = await fetch(`${session.baseUrl}/status/models`, {
    headers: { 'X-Desktop-Token': session.token },
  });
  if (!response.ok) {
    throw new DesktopSessionError(`GET /status/models failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ModelStatus;
}

/**
 * First-run gate predicate (AC5): block ONLY when a REAL inference engine has
 * no staged GGUF for either profile. The CI/dev stub answers /ask without
 * weights, so blocking it would falsely gate a working path.
 */
export function modelsAbsentForRealEngine(models: ModelStatus | null): boolean {
  if (!models) return false;
  return models.engine !== 'stub' && !models.models.quality.present && !models.models.fast.present;
}
