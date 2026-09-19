/**
 * PacksPanel — C7 (issue #74): the Electron-mode Knowledge Packs panel on the
 * Documents page. Lists installed pack versions (name, version, source_class,
 * published_at, active/superseded status), installs dropped/selected .zip
 * packs through the pack-install API, and offers per-version remove (behind
 * an explicit two-step confirmation, DocumentList precedent) and rollback on
 * superseded versions.
 *
 * Frozen UI seams (mirrored by desktop/e2e/c7-packs.spec.ts and
 * web_ui/src/pages/DocumentsPage.packs.test.tsx — keep all three in sync):
 *   heading accessible name  `Knowledge Packs`
 *   data-testid="packs-panel"                       panel container
 *   data-testid="pack-row-<packId>-<version>"       one row per version
 *   data-testid="pack-status-<packId>-<version>"    visible `active`|`superseded`
 *   data-testid="pack-install-input"                .zip file input (own
 *                                                   onChange -> installPack)
 *   data-testid="pack-remove-<packId>-<version>"    aria-label `Remove <id> <ver>`
 *   data-testid="pack-remove-confirm" / "pack-remove-cancel"
 *   data-testid="pack-rollback-<packId>-<version>"  aria-label `Rollback <id> to <ver>`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, PackInfo } from '../lib/api';
import { useToast } from './ToastProvider';

interface PacksPanelProps {
  apiClient: ApiClient;
}

interface RowKey {
  packId: string;
  version: string;
}

function rowId(pack: PackInfo): string {
  return `${pack.packId}-${pack.version}`;
}

function isZip(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip');
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  // UTC on purpose: published_at is a date-only manifest field; rendering in
  // the viewer's timezone shifted UTC-midnight timestamps a day for anyone
  // west of UTC.
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { timeZone: 'UTC' });
}

export function PacksPanel({ apiClient }: PacksPanelProps) {
  const { showToast } = useToast();
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState<RowKey | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Focus restoration for the two-step remove flow (WCAG focus order):
   * after Confirm/Cancel collapses the dialog, keyboard focus returns to the
   * row's Remove control instead of dropping to <body>. */
  const focusRemoveControl = useCallback((key: RowKey) => {
    const control = document.querySelector(
      `[data-testid="pack-remove-${key.packId}-${key.version}"]`,
    );
    (control as HTMLElement | null)?.focus();
  }, []);

  const refresh = useCallback(async (): Promise<PackInfo[]> => {
    const list = await apiClient.listPacks();
    setPacks(list);
    setLoading(false);
    return list;
  }, [apiClient]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((err: unknown) => {
      if (!cancelled) {
        setLoading(false);
        showToast(err instanceof Error ? err.message : 'Failed to load packs', 'error');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const installFile = useCallback(
    async (file: File) => {
      if (!isZip(file)) {
        showToast(`${file.name}: pack install accepts .zip archives only`, 'error');
        return;
      }
      setInstalling(true);
      setWorking(true);
      try {
        const result = await apiClient.installPack(file);
        await refresh();
        showToast(`Installed ${result.packId} v${result.version}`, 'success');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Pack install failed', 'error');
      } finally {
        setInstalling(false);
        setWorking(false);
      }
    },
    [apiClient, refresh, showToast],
  );

  const handleRemove = useCallback(
    async (key: RowKey) => {
      setWorking(true);
      try {
        await apiClient.removePack(key.packId, key.version);
        await refresh();
        showToast(`Removed ${key.packId} v${key.version}`, 'success');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Pack removal failed', 'error');
      } finally {
        setConfirmingRemove(null);
        setWorking(false);
        focusRemoveControl(key);
      }
    },
    [apiClient, focusRemoveControl, refresh, showToast],
  );

  const handleRollback = useCallback(
    async (key: RowKey) => {
      setWorking(true);
      try {
        await apiClient.rollbackPack(key.packId, key.version);
        await refresh();
        showToast(`Rolled back ${key.packId} to v${key.version}`, 'success');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Rollback failed', 'error');
      } finally {
        setWorking(false);
      }
    },
    [apiClient, refresh, showToast],
  );

  // Active version of each pack first, then superseded versions; groups stay
  // together and newest versions lead within a pack.
  const sorted = [...packs].sort((a, b) => {
    if (a.packId !== b.packId) return a.packId.localeCompare(b.packId);
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.version.localeCompare(b.version);
  });

  // First load gates the mount: the panel (heading + rows) appears together
  // with its data, so consumers never observe a populated-heading/empty-body
  // intermediate state.
  if (loading) return null;

  return (
    <section
      data-testid="packs-panel"
      aria-labelledby="packs-panel-heading"
      style={{ marginBottom: 'var(--spacing-lg, 16px)' }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        // Sequential on purpose: parallel installs interleave refresh() and
        // race the shared installing/working flags.
        void (async () => {
          for (const file of Array.from(e.dataTransfer.files)) {
            await installFile(file);
          }
        })();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm, 8px)' }}>
        <h3 id="packs-panel-heading" style={{ margin: 0, flex: 1 }}>
          Knowledge Packs
        </h3>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={working}
        >
          {installing ? 'Installing…' : 'Install pack .zip'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          data-testid="pack-install-input"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void installFile(file);
          }}
        />
      </div>
      {sorted.length === 0 ? (
        <p style={{ color: 'var(--color-text)' }}>
          No knowledge packs installed. Drop a .zip pack here or use the install button.
        </p>
      ) : (
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sorted.map((pack) => {
            const key = { packId: pack.packId, version: pack.version };
            const confirming =
              confirmingRemove !== null &&
              confirmingRemove.packId === pack.packId &&
              confirmingRemove.version === pack.version;
            const published = formatDate(pack.publishedAt);
            return (
              <li
                key={rowId(pack)}
                role="listitem"
                data-testid={`pack-row-${rowId(pack)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-sm, 8px)',
                  padding: 'var(--spacing-xs, 4px) 0',
                  borderBottom: '1px solid var(--color-border, #ddd)',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{pack.name ?? pack.packId}</strong>{' '}
                  <span>v{pack.version}</span>
                  {pack.sourceClass && (
                    <span style={{ color: 'var(--color-text)' }}>
                      {' '}
                      · {pack.sourceClass}
                    </span>
                  )}
                  {published && (
                    <span style={{ color: 'var(--color-text)' }}> · {published}</span>
                  )}
                </span>
                <span
                  data-testid={`pack-status-${rowId(pack)}`}
                  style={{
                    color: 'var(--color-text)',
                    fontWeight: pack.active ? 700 : 400,
                  }}
                >
                  {pack.active ? 'active' : 'superseded'}
                </span>
                {!pack.active && (
                  <button
                    type="button"
                    data-testid={`pack-rollback-${rowId(pack)}`}
                    aria-label={`Rollback ${pack.packId} to ${pack.version}`}
                    disabled={working}
                    onClick={() => void handleRollback(key)}
                  >
                    Rollback
                  </button>
                )}
                {confirming ? (
                  <>
                    <button
                      type="button"
                      data-testid="pack-remove-confirm"
                      disabled={working}
                      onClick={() => void handleRemove(key)}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      data-testid="pack-remove-cancel"
                      onClick={() => {
                        setConfirmingRemove(null);
                        focusRemoveControl(key);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid={`pack-remove-${rowId(pack)}`}
                    aria-label={`Remove ${pack.packId} ${pack.version}`}
                    disabled={working}
                    onClick={() => setConfirmingRemove(key)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
