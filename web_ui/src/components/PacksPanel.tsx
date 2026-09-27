/**
 * PacksPanel — C7 (issue #74): the Electron-mode Knowledge Packs panel on the
 * Documents page. Lists installed pack versions (name, version, source_class,
 * published_at, active/superseded status), installs dropped/selected .zip
 * packs through the pack-install API, and offers per-version remove (behind
 * an explicit two-step confirmation, DocumentList precedent) and rollback on
 * superseded versions.
 *
 * E5 (issue #88): rows with a signed feed update available carry an
 * "Update available" badge plus an Update action that download-verify-installs
 * through the desktop bridge (opt-in gated in the main process; zero network
 * until the user enabled updates in Settings). Update data arrives over the
 * desktopApi bridge — pull on mount + updates:available push subscription
 * (ADR-0010's boot-race answer) — never through the frozen OpenAPI contract.
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
 *   data-testid="pack-update-<packId>-<version>"    E5 update-available badge
 *   data-testid="pack-apply-<packId>-<version>"     E5 update apply action
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, PackInfo } from '../lib/api';
import type { UpdateStatus } from '../types/desktop';
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
  /** E5: packId -> available version, from the desktop bridge's update
   * status (pull on mount + updates:available push; absent in browser
   * mode where this panel is not mounted anyway). */
  const [updateByPack, setUpdateByPack] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ingestUpdateStatus = useCallback((status: UpdateStatus): void => {
    const next: Record<string, string> = {};
    for (const candidate of status.candidates) {
      next[candidate.packId] = candidate.availableVersion;
    }
    setUpdateByPack(next);
    if (status.lastApply !== null) {
      if (status.lastApply.applied) {
        showToast(
          `Updated ${status.lastApply.packId} to v${status.lastApply.version ?? ''}`,
          'success',
        );
      } else if (status.lastApply.reason) {
        showToast(`Update refused: ${status.lastApply.reason}`, 'error');
      }
    }
  }, [showToast]);

  useEffect(() => {
    const bridge = window.desktopApi;
    if (bridge === undefined) return undefined;
    // Optional calls: a bridge without the E5 methods (stubs, or a renderer
    // against an older main) degrades to "no update surface", never a crash.
    let unsubscribe: (() => void) | undefined;
    void bridge
      .getUpdateStatus?.()
      ?.then((status) => ingestUpdateStatus(status))
      .catch(() => {
        /* bridge present but update IPC not ready (older main) — stays empty */
      });
    unsubscribe = bridge.onUpdateAvailable?.((status) => ingestUpdateStatus(status));
    return () => {
      unsubscribe?.();
    };
  }, [ingestUpdateStatus]);

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

  /** E5: apply a signed feed update through the desktop bridge
   * (download -> Ed25519+sha256 verify -> loopback C8 install). */
  const handleApplyUpdate = useCallback(
    async (packId: string) => {
      const bridge = window.desktopApi;
      if (bridge === undefined) return;
      setApplying(packId);
      try {
        const result = await bridge.applyPackUpdate?.(packId);
        if (result !== undefined && !result.ok && result.detail) {
          showToast(`Update failed: ${result.detail}`, 'error');
        }
        await refresh();
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Update failed', 'error');
      } finally {
        setApplying(null);
      }
    },
    [refresh, showToast],
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
                {pack.active && updateByPack[pack.packId] !== undefined && (
                  <>
                    <span
                      data-testid={`pack-update-${rowId(pack)}`}
                      style={{ color: 'var(--color-accent, #06c)', fontWeight: 600 }}
                    >
                      Update available: v{updateByPack[pack.packId]}
                    </span>
                    <button
                      type="button"
                      data-testid={`pack-apply-${rowId(pack)}`}
                      aria-label={`Update ${pack.packId} to ${updateByPack[pack.packId]}`}
                      disabled={working || applying !== null}
                      onClick={() => void handleApplyUpdate(pack.packId)}
                    >
                      {applying === pack.packId ? 'Updating…' : 'Update'}
                    </button>
                  </>
                )}
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
