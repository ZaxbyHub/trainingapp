/**
 * Persistent session-level retrieval-degradation notice (#268, trace
 * collated-275-268 U7). While the retrieval-health store holds
 * `keyword-only`, the chat view shows EXACTLY ONE persistent status notice
 * naming the cause and the remedy; while `ok`, nothing is rendered. Takes
 * no required props and subscribes to the store itself.
 */

import React, { useEffect, useState } from 'react';
import {
  getRetrievalHealth,
  subscribe,
  type RetrievalHealthState,
} from '../lib/rag/retrieval-health';

export function RetrievalHealthNotice(): React.JSX.Element | null {
  const [health, setHealth] = useState<RetrievalHealthState>(() => getRetrievalHealth());

  useEffect(() => {
    const unsubscribe = subscribe(setHealth);
    return unsubscribe;
  }, []);

  if (health.status !== 'keyword-only') {
    return null;
  }

  return (
    <div role="status" className="retrieval-health-notice">
      Semantic search is unavailable ({health.cause}); answering with keyword
      search only. Check that the embedding model is staged and reload, or
      retry from Settings.
    </div>
  );
}
