/**
 * PacksPanel — C7 (issue #74): the Knowledge Packs panel on the Documents
 * page, in BOTH apps (browser-training-parity AC4: the browser app reuses
 * this panel over the PackClient seam — desktop: loopback pack API +
 * preload update bridge; browser: origin-private pack store + browser update
 * controller). Lists installed pack versions (name, version, source_class,
 * published_at, active/superseded status), installs dropped/selected .zip
 * packs through the pack-install API, and offers per-version remove (behind
 * an explicit two-step confirmation, DocumentList precedent) and rollback on
 * superseded versions.
 *
 * E5 (issue #88): rows with a signed feed update available carry an
 * "Update available" badge plus an Update action that download-verify-installs
 * through the desktop bridge (opt-in gated in the main process; zero network
 * until the user enabled updates in Settings). Update data arrives over the
 * PackClient's update bridge (window.desktopApi inside Electron, the browser
 * update controller otherwise) — pull on mount + updates:available push
 * subscription (ADR-0010's boot-race answer) — never through the frozen
 * OpenAPI contract.
 *
 * Browser app (AC9): a storage line (data-testid="packs-storage") reports the
 * origin's used/available bytes from navigator.storage.estimate() and whether
 * the browser granted persistent storage.
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
 *   data-testid="packs-storage"                     browser storage report
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient, PackInfo } from '../lib/api';
import type { StorageReport } from '../lib/packs/browser-pack-manager';
import { desktopPackClient, type PackClient } from '../lib/packs/pack-client';
import type { UpdateStatus } from '../types/desktop';
import { useToast } from './ToastProvider';
import { Badge, Button, Icon } from '../ui';
import { cx } from '../ui/cx';
import '../pages/documents.css';

interface PacksPanelProps {
  /** The pack seam (desktop or browser). */
  client?: PackClient;
  /** Desktop shorthand: wraps the loopback ApiClient in a desktop PackClient. */
  apiClient?: ApiClient;
  /**
   * Lumen phase 6 ("Documents | Training packs" tabs). Omitted (standalone): one
   * panel with every row inline, as before. Given: this ALWAYS-MOUNTED instance
   * keeps all state, toasts and the single `pack-install-input`, and portals the
   * knowledge section (testid packs-panel) into `knowledge` and the training-class
   * rows into `training`, whichever of the two slots is currently mounted (null =
   * that tab is not showing).
   */
  slots?: { knowledge: HTMLElement | null; training: HTMLElement | null };
  /** Called when a training-class row APPEARS after the first load (never on it). */
  onTrainingPackAdded?: () => void;
  /** Bump to re-list (installs the page made itself; the desktop client has no subscribe). */
  refreshToken?: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
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

const isTrainingPack = (pack: PackInfo): boolean => pack.sourceClass === 'training';

export function PacksPanel({
  client: clientProp,
  apiClient,
  slots,
  onTrainingPackAdded,
  refreshToken,
}: PacksPanelProps) {
  const { showToast } = useToast();
  const client = useMemo<PackClient>(() => {
    if (clientProp !== undefined) return clientProp;
    if (apiClient !== undefined) return desktopPackClient(apiClient);
    throw new Error('PacksPanel needs a PackClient (client) or a desktop ApiClient (apiClient)');
  }, [clientProp, apiClient]);
  const [storage, setStorage] = useState<StorageReport | null>(null);
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
  // PRF-003: lastApply is sticky in main's status, so every push/pull would
  // re-toast an old outcome. Consume by appliedAt — toast only the first
  // delivery of each apply result.
  const lastApplyToastRef = useRef<string | null>(null);

  const ingestUpdateStatus = useCallback((status: UpdateStatus): void => {
    const next: Record<string, string> = {};
    for (const candidate of status.candidates) {
      next[candidate.packId] = candidate.availableVersion;
    }
    setUpdateByPack(next);
    const lastApply = status.lastApply;
    if (lastApply !== null && lastApply.appliedAt !== lastApplyToastRef.current) {
      lastApplyToastRef.current = lastApply.appliedAt;
      if (lastApply.applied) {
        showToast(
          `Updated ${lastApply.packId} to v${lastApply.version ?? ''}`,
          'success',
        );
      } else if (lastApply.reason) {
        showToast(`Update refused: ${lastApply.reason}`, 'error');
      }
    }
  }, [showToast]);

  useEffect(() => {
    const bridge = client.updates;
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

  const refreshStorage = useCallback(async (): Promise<void> => {
    if (client.storageReport === undefined) return;
    try {
      setStorage(await client.storageReport());
    } catch {
      setStorage(null);
    }
  }, [client]);

  // Row keys seen by the last successful list (null until the first load), so a
  // training pack that APPEARS later can be announced without firing on load.
  const knownRowsRef = useRef<Set<string> | null>(null);
  const onTrainingPackAddedRef = useRef(onTrainingPackAdded);
  onTrainingPackAddedRef.current = onTrainingPackAdded;
  // Set when a training pack appeared while the Training packs tab was not
  // showing; consumed when that tab mounts (the page may defer the switch).
  const switchSignaledRef = useRef(false);
  // Latest slots, read inside `refresh` (stable callback) to tell whether the
  // Training packs tab is already showing when a training pack appears.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  // Polite announcement for the switch, in an always-mounted live region.
  const [announcement, setAnnouncement] = useState('');
  // Out-of-order guard: concurrent refreshes (install, store notification,
  // refreshToken) may resolve out of order; only the newest response applies,
  // so a stale list can neither roll the rows back nor re-fire the signal.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const refresh = useCallback(async (): Promise<PackInfo[]> => {
    const seq = ++requestSeqRef.current;
    const list = await client.listPacks();
    if (seq < appliedSeqRef.current) return list; // a newer response already applied
    appliedSeqRef.current = seq;
    setPacks(list);
    setLoading(false);
    const known = knownRowsRef.current;
    knownRowsRef.current = new Set(list.map(rowId));
    if (known !== null && list.some((pack) => isTrainingPack(pack) && !known.has(rowId(pack)))) {
      // Only flag a pending switch when the Training packs tab is NOT showing;
      // otherwise the flag would survive until a later manual round-trip and
      // announce a switch that never happened.
      if (slotsRef.current?.training == null) switchSignaledRef.current = true;
      onTrainingPackAddedRef.current?.();
    }
    void refreshStorage();
    return list;
  }, [client, refreshStorage]);

  // WCAG 2.4.3 / 4.1.3: when the Training packs tab mounts after a signal, the
  // Documents panel (and anything focused in it) is gone. If focus was lost with
  // it, move focus to the Training packs heading; if the user is focused
  // elsewhere, leave focus alone and announce the switch politely instead.
  const trainingSlotElement = slots?.training ?? null;
  useEffect(() => {
    if (trainingSlotElement === null || !switchSignaledRef.current) {
      // Any tab change without a pending signal drops a stale announcement so
      // the next real one is a fresh live-region change.
      setAnnouncement('');
      return;
    }
    switchSignaledRef.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.getElementById('training-packs-heading')?.focus();
      return;
    }
    setAnnouncement('A new training pack was added. Showing the Training packs tab.');
  }, [trainingSlotElement]);

  const initialRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === initialRefreshToken.current) return;
    void refresh().catch(() => undefined);
  }, [refreshToken, refresh]);

  // Installs/removals made elsewhere in this tab (e.g. an update applied from
  // the Settings page) refresh the list.
  useEffect(() => {
    if (client.subscribe === undefined) return undefined;
    return client.subscribe(() => {
      void refresh().catch(() => undefined);
    });
  }, [client, refresh]);

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
        const result = await client.installPack(file);
        await refresh();
        showToast(`Installed ${result.packId} v${result.version}`, 'success');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Pack install failed', 'error');
      } finally {
        setInstalling(false);
        setWorking(false);
      }
    },
    [client, refresh, showToast],
  );

  const handleRemove = useCallback(
    async (key: RowKey) => {
      setWorking(true);
      try {
        await client.removePack(key.packId, key.version);
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
    [client, focusRemoveControl, refresh, showToast],
  );

  const handleRollback = useCallback(
    async (key: RowKey) => {
      setWorking(true);
      try {
        await client.rollbackPack(key.packId, key.version);
        await refresh();
        showToast(`Rolled back ${key.packId} to v${key.version}`, 'success');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Rollback failed', 'error');
      } finally {
        setWorking(false);
      }
    },
    [client, refresh, showToast],
  );

  /** E5: apply a signed feed update through the update bridge
   * (download -> Ed25519+sha256 verify -> the shared install path). */
  const handleApplyUpdate = useCallback(
    async (packId: string) => {
      const bridge = client.updates;
      if (bridge === undefined) return;
      setApplying(packId);
      try {
        const result = await bridge.applyPackUpdate?.(packId);
        // The outcome toast fires exactly once via ingestUpdateStatus (the
        // handler pushes status with a fresh appliedAt); don't double-toast
        // from the invoke return (PRF-003).
        if (result?.status !== undefined) {
          ingestUpdateStatus(result.status);
        }
        await refresh();
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Update failed', 'error');
      } finally {
        setApplying(null);
      }
    },
    [client, ingestUpdateStatus, refresh, showToast],
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

  const capabilityIssue = client.capabilityIssue?.() ?? null;
  const split = slots !== undefined;
  const mainRows = split ? sorted.filter((pack) => !isTrainingPack(pack)) : sorted;
  const trainingRows = split ? sorted.filter(isTrainingPack) : [];

  const renderRow = (pack: PackInfo) => {
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
        className="app-packs__row"
      >
        <span className="app-packs__ident">
          <strong className="app-packs__name">{pack.name ?? pack.packId}</strong>{' '}
          <span>v{pack.version}</span>
          {pack.sourceClass && (
            <span className="app-packs__meta">
              {' '}
              · {pack.sourceClass}
            </span>
          )}
          {published && <span className="app-packs__meta"> · {published}</span>}
        </span>
        <Badge data-testid={`pack-status-${rowId(pack)}`} tone={pack.active ? 'success' : 'neutral'}>
          {pack.active ? 'active' : 'superseded'}
        </Badge>
        {pack.active && updateByPack[pack.packId] !== undefined && (
          <>
            <Badge data-testid={`pack-update-${rowId(pack)}`} tone="accent">
              Update available: v{updateByPack[pack.packId]}
            </Badge>
            <Button
              size="sm"
              variant="primary"
              data-testid={`pack-apply-${rowId(pack)}`}
              aria-label={`Update ${pack.packId} to ${updateByPack[pack.packId]}`}
              disabled={working || applying !== null}
              aria-disabled={working || applying !== null || undefined}
              onClick={() => void handleApplyUpdate(pack.packId)}
            >
              {applying === pack.packId ? 'Updating…' : 'Update'}
            </Button>
          </>
        )}
        {!pack.active && (
          <Button
            size="sm"
            variant="secondary"
            data-testid={`pack-rollback-${rowId(pack)}`}
            aria-label={`Rollback ${pack.packId} to ${pack.version}`}
            disabled={working}
            aria-disabled={working || undefined}
            onClick={() => void handleRollback(key)}
          >
            Rollback
          </Button>
        )}
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="danger"
              data-testid="pack-remove-confirm"
              disabled={working}
              aria-disabled={working || undefined}
              onClick={() => void handleRemove(key)}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="pack-remove-cancel"
              onClick={() => {
                setConfirmingRemove(null);
                focusRemoveControl(key);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`pack-remove-${rowId(pack)}`}
            aria-label={`Remove ${pack.packId} ${pack.version}`}
            disabled={working}
            aria-disabled={working || undefined}
            onClick={() => setConfirmingRemove(key)}
          >
            Remove
          </Button>
        )}
      </li>
    );
  };

  const onDropInstall = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    // Sequential on purpose: parallel installs interleave refresh() and
    // race the shared installing/working flags.
    void (async () => {
      for (const file of Array.from(e.dataTransfer.files)) {
        await installFile(file);
      }
    })();
  };

  const installInput = (
    <input
      ref={inputRef}
      type="file"
      accept=".zip"
      data-testid="pack-install-input"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void installFile(file);
      }}
    />
  );

  const installButton = (label: string) => (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => inputRef.current?.click()}
      disabled={working}
      aria-disabled={working || undefined}
    >
      <Icon name="upload" size={16} />
      {installing ? 'Installing…' : label}
    </Button>
  );

  const storageNote = (withTestId: boolean) =>
    storage !== null ? (
      <p
        data-testid={withTestId ? 'packs-storage' : undefined}
        className={cx('app-packs__note', storage.persisted === false && 'app-packs__note--warning')}
      >
        <Icon name={storage.persisted === false ? 'triangle-alert' : 'info'} size={16} />
        <span>
          Browser storage: {formatBytes(storage.usage)} used, {formatBytes(storage.available)} available
          {storage.persisted === true
            ? ' (persistent: the browser will not evict installed packs)'
            : storage.persisted === false
              ? ' (not persistent: the browser may evict installed packs under storage pressure)'
              : ''}
        </span>
      </p>
    ) : null;

  // Lumen phase 6: a Card with an h2 (h1 is the page title). Every control keeps
  // its native `disabled` (tests and keyboard order rely on it) and also carries
  // aria-disabled so the Lumen Button renders its disabled look.
  const knowledgeSection = (input: ReactNode) => (
    <section
      data-testid="packs-panel"
      aria-labelledby="packs-panel-heading"
      className="ui-card app-packs"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={onDropInstall}
    >
      <div className="app-packs__head">
        <h2 id="packs-panel-heading" className="app-packs__title">
          Knowledge Packs
        </h2>
        {installButton('Install pack .zip')}
        {input}
      </div>
      {capabilityIssue != null && (
        <p role="status" data-testid="packs-capability" className="app-packs__note app-packs__note--warning">
          <Icon name="triangle-alert" size={16} />
          <span>{capabilityIssue}</span>
        </p>
      )}
      {storageNote(true)}
      {mainRows.length === 0 ? (
        <p className="app-packs__empty">
          No knowledge packs installed. Drop a .zip pack here or use the install button.
        </p>
      ) : (
        <ul role="list" className="app-packs__list">
          {mainRows.map(renderRow)}
        </ul>
      )}
    </section>
  );

  // Standalone: one panel, every row inline (unchanged behaviour).
  if (slots === undefined) return knowledgeSection(installInput);

  // Tabbed page: this always-mounted instance renders only the hidden install
  // input in place; each section portals into its tab's slot while that tab is
  // mounted (the Tabs primitive mounts only the active panel's content).
  return (
    <>
      {installInput}
      <p role="status" className="ui-visually-hidden">
        {announcement}
      </p>
      {slots.knowledge ? createPortal(knowledgeSection(null), slots.knowledge) : null}
      {slots.training
        ? createPortal(
            <section
              data-testid="training-packs"
              aria-labelledby="training-packs-heading"
              className="ui-card app-packs"
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={onDropInstall}
            >
              <div className="app-packs__head">
                <h2 id="training-packs-heading" className="app-packs__title ui-focusable" tabIndex={-1}>
                  Training packs
                </h2>
                {installButton('Install course pack .zip')}
              </div>
              {capabilityIssue != null && (
                <p role="status" className="app-packs__note app-packs__note--warning">
                  <Icon name="triangle-alert" size={16} />
                  <span>{capabilityIssue}</span>
                </p>
              )}
              {storageNote(false)}
              {trainingRows.length === 0 ? (
                <p className="app-packs__empty">
                  No training packs installed. Install a Storyline course pack (.zip) here; its course then plays
                  on the Training page.
                </p>
              ) : (
                <ul role="list" className="app-packs__list">
                  {trainingRows.map(renderRow)}
                </ul>
              )}
            </section>,
            slots.training
          )
        : null}
    </>
  );
}
