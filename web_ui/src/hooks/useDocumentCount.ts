/**
 * Hook that subscribes to the persisted document count.
 *
 * U4: used by the empty-chat state to decide whether to show the "no documents
 * yet" hint. The repo's document persistence layer
 * (`src/lib/storage/document-store.ts`) uses the raw IndexedDB API rather than
 * Dexie, so there is no reactive `liveQuery` source to subscribe to. Instead we
 * count on mount and re-count whenever the user returns to this tab
 * (`visibilitychange`). This keeps the count fresh after background uploads or
 * deletes performed in another tab without burning a polling timer.
 *
 * `loadDocuments` already swallows IndexedDB errors and returns `[]`, so the
 * hook is robust to the object store not existing (e.g. a fresh profile before
 * the first migration): `count` simply reports `0`.
 *
 * B9 (issue #67): inside Electron the AUTHORITATIVE count is the desktop
 * backend's (`GET /documents`), not IndexedDB — the same upload/delete calls
 * the DocumentsPage makes. The Electron branch also exposes `recount()` so
 * same-tab mutations (upload/clear resolve) can refresh the badge immediately;
 * `visibilitychange` alone cannot observe in-tab mutations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDocuments } from '../lib/storage/document-store';
import { isElectron, useDesktopSession } from '../lib/desktop-session';

export interface UseDocumentCountResult {
  /** Number of persisted documents, or 0 if the store is unavailable. */
  count: number;
  /** True until the initial count has resolved. */
  loading: boolean;
  /**
   * Force a re-count (B9 Electron branch). Resolves the fresh backend total;
   * a no-op promise in the browser-local branch (which recounts on
   * visibilitychange).
   */
  recount: () => Promise<void>;
}

/**
 * Subscribe to the persisted document count.
 *
 * Re-counts on mount and whenever the document becomes visible again (so a
 * user returning to the tab sees deletes/uploads performed elsewhere).
 *
 * @returns `{ count, loading, recount }` — `loading` is true until the first
 *   count resolves, then false for the rest of the hook's lifetime.
 */
export function useDocumentCount(): UseDocumentCountResult {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const { session } = useDesktopSession();
  const electron = isElectron() && session !== null;

  // F11 (issue #67 review): monotonic sequence so an out-of-order response
  // from an earlier recount can never overwrite a fresher count.
  const recountSeq = useRef(0);
  const recount = useCallback(async () => {
    const seq = ++recountSeq.current;
    const apply = (value: number) => {
      if (recountSeq.current !== seq) return;
      setCount(value);
      setLoading(false);
    };
    // B9: inside Electron the backend store is authoritative.
    if (electron && session) {
      try {
        const listing = await session.apiClient.listDocuments();
        apply(typeof listing?.total === 'number' ? listing.total : 0);
      } catch {
        // Backend hiccup — report empty rather than a stale IndexedDB count.
        apply(0);
      }
      return;
    }
    try {
      const docs = await loadDocuments();
      apply(Array.isArray(docs) ? docs.length : 0);
    } catch {
      // Store missing / unavailable — treat as empty.
      apply(0);
    }
  }, [electron, session]);

  useEffect(() => {
    let cancelled = false;
    // Initial count on mount.
    void (async () => {
      await recount();
      if (cancelled) return;
    })();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void recount();
      }
    };
    // C-7 (issue #67): DocumentsPage's Electron handlers dispatch this after
    // same-tab upload/clear, because visibilitychange cannot observe in-tab
    // mutations.
    const handleDocumentsChanged = () => {
      void recount();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('documents-changed', handleDocumentsChanged);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('documents-changed', handleDocumentsChanged);
    };
  }, [recount]);

  return { count, loading, recount };
}
