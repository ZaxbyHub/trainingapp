/**
 * SettingsStorageSection — the storage-pressure surface (issue #34 item 7,
 * AC4, check C4; plan R2): a live navigator.storage.estimate() usage/quota
 * report with a meter, a near-quota classification (usage above 85% of quota
 * renders the warning tone and the near-quota note inside an always-mounted
 * polite live region), the persisted() state, and a Request-persist control
 * invoking navigator.storage.persist().
 *
 * Rendered inside the Settings "Storage & privacy" section. The estimate
 * refreshes on mount and on demand (Recheck) — the browser's own numbers
 * move as packs, models and documents come and go.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressBar } from '../components/SettingsMetrics';
import { Button } from '../ui';

/** usage above this fraction of quota renders the near-quota warning. */
export const NEAR_QUOTA_FRACTION = 0.85;

interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

interface StorageLike {
  estimate?: () => Promise<StorageEstimateLike>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

function storageApi(): StorageLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as { storage?: StorageLike }).storage;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function SettingsStorageSection(): React.ReactElement {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [persistBusy, setPersistBusy] = useState(false);
  const [persistNote, setPersistNote] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const storage = storageApi();
    if (storage === undefined || typeof storage.estimate !== 'function') {
      setEstimateError('Storage information is not available in this browser.');
      return;
    }
    try {
      const result = await storage.estimate();
      if (!aliveRef.current) return;
      setEstimate({ usage: result.usage ?? 0, quota: result.quota ?? 0 });
      setEstimateError(null);
    } catch {
      if (aliveRef.current) setEstimateError('Storage usage could not be read.');
    }
    if (typeof storage.persisted === 'function') {
      try {
        const value = await storage.persisted();
        if (aliveRef.current) setPersisted(value === true);
      } catch {
        if (aliveRef.current) setPersisted(null);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestPersist = useCallback(async () => {
    const storage = storageApi();
    if (storage === undefined || typeof storage.persist !== 'function') {
      setPersistNote('Persistent storage cannot be requested in this browser.');
      return;
    }
    setPersistBusy(true);
    try {
      const granted = await storage.persist();
      setPersisted(granted === true);
      setPersistNote(
        granted === true
          ? 'Persistent storage granted — the browser will not evict this app’s data under storage pressure.'
          : 'Persistent storage was not granted — the browser may evict data under storage pressure.',
      );
    } catch {
      setPersistNote('The persistence request failed.');
    } finally {
      setPersistBusy(false);
    }
  }, []);

  const usage = estimate?.usage ?? 0;
  const quota = estimate?.quota ?? 0;
  const ratio = quota > 0 ? usage / quota : 0;
  const nearQuota = quota > 0 && ratio > NEAR_QUOTA_FRACTION;
  const percent = quota > 0 ? Math.min(100, Math.round(ratio * 100)) : 0;

  return (
    <div className="settings-group" data-testid="settings-storage-section">
      <p className="settings-label">Browser storage</p>
      {estimateError !== null ? (
        // A persistent capability gap (no storage API in this browser), not
        // an announcement — a plain <p>, no alert role.
        <p className="settings-text">{estimateError}</p>
      ) : estimate === null ? (
        <p className="settings-text">Reading storage usage…</p>
      ) : (
        <>
          <ProgressBar
            value={usage}
            max={quota}
            color={nearQuota ? 'danger' : percent > 60 ? 'warning' : 'success'}
            label={`Storage used (${formatBytes(usage)} of ${formatBytes(quota)})`}
          />
          {/* Always-mounted polite region (the repo's live-region rule): only
              the text changes when the estimate moves or the classification
              flips, so the near-quota warning is announced. */}
          <p className="settings-text" role="status" aria-live="polite" data-testid="settings-storage-status">
            {formatBytes(usage)} used of {formatBytes(quota)} available ({percent}%)
            {nearQuota ? ' — near quota: free up space or move large packs to another device.' : ''}
          </p>
          {nearQuota && (
            <p className="settings-text settings-tone--warning" data-testid="settings-storage-near-quota">
              Storage is nearly full. New documents, packs or models may fail to save.
            </p>
          )}
        </>
      )}
      <div className="settings-row">
        <span className="settings-text" data-testid="settings-storage-persisted">
          {persisted === null
            ? 'Persistence state unknown.'
            : persisted
              ? 'Storage is persistent (protected from automatic eviction).'
              : 'Storage is not persistent (the browser may evict it under pressure).'}
        </span>
        {persisted !== true && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="settings-storage-persist-btn"
            loading={persistBusy}
            disabled={persistBusy}
            aria-disabled={persistBusy || undefined}
            onClick={() => void requestPersist()}
          >
            {persistBusy ? 'Requesting…' : 'Request persistent storage'}
          </Button>
        )}
        <Button variant="secondary" size="sm" data-testid="settings-storage-recheck" onClick={() => void refresh()}>
          Recheck
        </Button>
      </div>
      {persistNote !== null && (
        <p className="settings-text" role="status" data-testid="settings-storage-persist-note">
          {persistNote}
        </p>
      )}
    </div>
  );
}
