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
 */

import { useCallback, useEffect, useState } from 'react';
import { loadDocuments } from '../lib/storage/document-store';

export interface UseDocumentCountResult {
  /** Number of persisted documents, or 0 if the store is unavailable. */
  count: number;
  /** True until the initial count has resolved. */
  loading: boolean;
}

/**
 * Subscribe to the persisted document count.
 *
 * Re-counts on mount and whenever the document becomes visible again (so a
 * user returning to the tab sees deletes/uploads performed elsewhere).
 *
 * @returns `{ count, loading }` — `loading` is true until the first count
 *   resolves, then false for the rest of the hook's lifetime.
 */
export function useDocumentCount(): UseDocumentCountResult {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const recount = useCallback(async () => {
    try {
      const docs = await loadDocuments();
      setCount(Array.isArray(docs) ? docs.length : 0);
    } catch {
      // Store missing / unavailable — treat as empty.
      setCount(0);
    } finally {
      setLoading(false);
    }
  }, []);

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
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [recount]);

  return { count, loading };
}
