/**
 * TrainingPage — the Training tab surface.
 *
 * Storyline player mount (issue #81, D5): a `training` source-class pack
 * opens the embedded player. The pack to open comes from the `pack` query
 * parameter of the current location (e.g. app://index.html?pack=opmed-cdp-mlc),
 * with the Learn panel (D6, issue #82) able to deep-link here: an
 * `initialPackId` prop (lifted navigation target from chat) takes precedence,
 * and a `pendingSlideId` is passed to the player as its initialSlideId so the
 * auto-jump fires exactly once, after the pack resolves.
 *
 * Document packs (#133): a `bundled`/`user` source-class pack (the built-in
 * knowledge content) has no player assets — it renders a document reader over
 * the pack's own files, served by the reserved app://training route. The tab
 * lists INSTALLED packs with a picker (the update path: install a newer pack
 * zip from the Documents page, then pick it here), auto-selects the sole
 * installed pack when nothing else is chosen, and remembers the last
 * selection. The `?pack=` value is the managed pack DIRECTORY path
 * (`<packId>/<version>`), matching what the player route serves.
 */
import { useEffect, useMemo, useState } from 'react';
import { TrainingPlayer } from '../components/TrainingPlayer';
import type { TrainingPlayerSlideState } from '../components/training-player-bridge';
import { useDesktopSession } from '../lib/desktop-session';
import type { PackInfo } from '../lib/api/types';

export interface TrainingPageProps {
  /** D6 (issue #82): pack from the lifted chat navigation target. */
  initialPackId?: string;
  /** D6 (issue #82): slide to jump to once a pack is open. */
  pendingSlideId?: string;
  /**
   * D7 (issue #83): forwarded VERBATIM to TrainingPlayer.onSlideChange — the
   * frozen `{slideId, slideTitle}` payload reaches the caller (App, which owns
   * the pinned-slide state) unchanged. Do not decorate the event here.
   */
  onSlideChange?: (event: TrainingPlayerSlideState) => void;
}

interface PackDocEntry {
  path: string;
  title: string;
  mime: string;
}

const LAST_PACK_KEY = 'training.lastPackDir';

/** Managed pack directory path (`<packId>/<version>`) — the form the reserved
 * app://training route serves for PackManager-installed packs. */
const packDirKey = (pack: { packId: string; version: string }): string =>
  `${pack.packId}/${pack.version}`;

const isPdf = (mime: string, path: string): boolean =>
  mime === 'application/pdf' || path.toLowerCase().endsWith('.pdf');

export function TrainingPage({ initialPackId, pendingSlideId, onSlideChange }: TrainingPageProps) {
  const { session: desktopSession } = useDesktopSession();
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docs, setDocs] = useState<PackDocEntry[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  // ?pack= is read from the location ONCE plus on explicit picker changes —
  // a plain memo would not see pushState, so an override state mirrors it.
  const [packOverride, setPackOverride] = useState<string | null>(null);

  const urlPack = useMemo(() => {
    if (initialPackId !== undefined && initialPackId !== '') return initialPackId;
    if (packOverride !== null) return packOverride;
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('pack') ?? '';
  }, [initialPackId, packOverride]);

  useEffect(() => {
    if (desktopSession === null) return;
    // Load-once: context providers may pass a fresh session object per
    // render, so an identity dependency would loop. The pack set only
    // changes through installs/removals on the Documents page — refreshed by
    // re-entering the tab.
    if (packs !== null || loadError !== null) return;
    let cancelled = false;
    void desktopSession.apiClient
      .listPacks()
      .then((listing: PackInfo[]) => {
        if (!cancelled) setPacks(listing.filter((pack) => pack.active));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [desktopSession, packs, loadError]);

  const activePacks = packs ?? [];
  // A lifted target (D6/D7) or a ?pack= value that does not resolve to an
  // INSTALLED pack is a training-pack deep link by construction (the Learn
  // panel only emits training packs) — render the player for it directly,
  // without consulting the pack list (the frozen D7 wire contract; it must
  // work with no desktop session at all).
  const deepLinkedPackDir =
    initialPackId !== undefined && initialPackId !== ''
      ? initialPackId
      : urlPack !== '' &&
          !activePacks.some(
            (pack) => packDirKey(pack) === urlPack || pack.packId === urlPack,
          )
        ? urlPack
        : '';
  const selectedPack = useMemo(() => {
    if (deepLinkedPackDir !== '') return undefined; // deep link bypasses the picker entirely
    if (urlPack !== '') {
      const byUrl = activePacks.find(
        (pack) => packDirKey(pack) === urlPack || pack.packId === urlPack,
      );
      if (byUrl !== undefined) return byUrl;
    }
    if (activePacks.length === 1) return activePacks[0];
    if (typeof window !== 'undefined' && activePacks.length > 1) {
      const last = window.localStorage.getItem(LAST_PACK_KEY);
      if (last !== null) {
        const byLast = activePacks.find((pack) => packDirKey(pack) === last);
        if (byLast !== undefined) return byLast;
      }
    }
    return undefined;
  }, [deepLinkedPackDir, urlPack, activePacks]);

  const selectedDir =
    deepLinkedPackDir !== ''
      ? deepLinkedPackDir
      : selectedPack !== undefined
        ? packDirKey(selectedPack)
        : '';
  const isStorylinePack = deepLinkedPackDir !== '' || selectedPack?.sourceClass === 'training';

  // Document-pack reader data: the pack manifest over the reserved route.
  useEffect(() => {
    if (desktopSession === null || selectedDir === '' || isStorylinePack) {
      setDocs(null);
      setDocsError(null);
      setSelectedDoc(null);
      return;
    }
    let cancelled = false;
    setDocs(null);
    setDocsError(null);
    setSelectedDoc(null);
    fetch(`app://training/${selectedDir.split('/').map(encodeURIComponent).join('/')}/pack.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`pack manifest fetch failed (HTTP ${res.status})`);
        return (await res.json()) as { docs?: PackDocEntry[] };
      })
      .then((manifest) => {
        if (cancelled) return;
        if (typeof window !== 'undefined') window.localStorage.setItem(LAST_PACK_KEY, selectedDir);
        setDocs(Array.isArray(manifest.docs) ? manifest.docs : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDocsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [desktopSession, selectedDir, isStorylinePack]);

  const selectPack = (dir: string): void => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (dir === '') url.searchParams.delete('pack');
    else url.searchParams.set('pack', dir);
    window.history.pushState({}, '', url);
    setPackOverride(dir);
  };

  const readerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 'var(--spacing-md)',
  };
  const listStyle: React.CSSProperties = {
    width: '300px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-xs)',
    padding: 'var(--spacing-sm)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
  };
  const docButtonStyle = (active: boolean): React.CSSProperties => ({
    textAlign: 'left',
    padding: 'var(--spacing-sm)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid ' + (active ? 'var(--color-primary)' : 'transparent'),
    background: active ? 'var(--color-bg-surface)' : 'transparent',
    cursor: 'pointer',
    fontFamily: 'var(--font-family)',
    fontSize: 'var(--font-size-caption)',
    color: 'var(--color-text-primary)',
  });

  if (deepLinkedPackDir !== '') {
    // D6/D7 wire contract: a lifted target renders the player directly — no
    // session or pack-list consultation (chat Learn links only ever target
    // installed training packs).
    return (
      <TrainingPlayer packId={deepLinkedPackDir} initialSlideId={pendingSlideId} onSlideChange={onSlideChange} />
    );
  }

  if (desktopSession === null) {
    return (
      <div style={{ padding: 'var(--spacing-md)', color: 'var(--color-text-muted)' }}>
        Training packs are available in the desktop app.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: 'var(--spacing-md)',
        gap: 'var(--spacing-sm)',
      }}
      data-testid="training-page"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
        <label
          htmlFor="training-pack-select"
          style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-muted)' }}
        >
          Pack:
        </label>
        <select
          id="training-pack-select"
          data-testid="training-pack-select"
          value={selectedDir}
          onChange={(event) => selectPack(event.target.value)}
          style={{ fontFamily: 'var(--font-family)', padding: 'var(--spacing-xs)' }}
        >
          <option value="">Select a pack…</option>
          {activePacks.map((pack) => {
            const dir = packDirKey(pack);
            return (
              <option key={dir} value={dir}>
                {pack.name ?? pack.packId} ({dir})
              </option>
            );
          })}
        </select>
        {activePacks.length > 0 && (
          <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-muted)' }}>
            To update the content, install a newer pack zip on the Documents page, then select it here.
          </span>
        )}
      </div>

      {loadError !== null && (
        <p role="alert" data-testid="training-pack-error" style={{ margin: 0, color: 'var(--color-danger, #d32f2f)' }}>
          Failed to load installed packs: {loadError}
        </p>
      )}

      {selectedDir === '' ? (
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-family)',
            fontSize: 'var(--font-size-body)',
          }}
        >
          {packs === null
            ? 'Loading installed packs…'
            : activePacks.length === 0
              ? 'No knowledge packs installed yet — complete first-run setup or install one from the Documents page.'
              : 'No training pack selected. Pick one above.'}
        </div>
      ) : isStorylinePack ? (
        <TrainingPlayer packId={selectedDir} initialSlideId={pendingSlideId} onSlideChange={onSlideChange} />
      ) : (
        <div style={readerStyle} data-testid="training-docs-reader">
          <div style={listStyle} data-testid="training-docs-list">
            {docsError !== null && (
              <p role="alert" style={{ margin: 0, color: 'var(--color-danger, #d32f2f)', fontSize: 'var(--font-size-caption)' }}>
                {docsError}
              </p>
            )}
            {docs === null && docsError === null && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-caption)' }}>
                Loading pack contents…
              </span>
            )}
            {docs?.map((doc) => {
              return (
                <button
                  key={doc.path}
                  type="button"
                  style={docButtonStyle(selectedDoc === doc.path)}
                  onClick={() => setSelectedDoc(doc.path)}
                  data-testid={`training-doc-${doc.path}`}
                >
                  {doc.title}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
            {selectedDoc !== null && docs !== null && (() => {
              const doc = docs.find((entry) => entry.path === selectedDoc);
              if (doc === undefined) return null;
              const fileUrl = `app://training/${selectedDir.split('/').map(encodeURIComponent).join('/')}/${doc.path
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`;
              return isPdf(doc.mime, doc.path) ? (
                <embed
                  src={fileUrl}
                  type="application/pdf"
                  style={{ flex: 1, minHeight: 0, borderRadius: 'var(--radius-md)' }}
                  data-testid="training-doc-viewer"
                />
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 'var(--spacing-sm)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-caption)' }}>
                    {doc.title} — this format opens externally (the extracted text is searchable in Chat).
                  </span>
                  <a
                    href={fileUrl}
                    download={doc.title}
                    style={{ fontFamily: 'var(--font-family)', fontSize: 'var(--font-size-caption)' }}
                    data-testid="training-doc-download"
                  >
                    Open / download {doc.title}
                  </a>
                </div>
              );
            })()}
            {selectedDoc === null && (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--font-size-caption)',
                }}
              >
                Select a document to read it. PDFs render inline; all pack content is searchable from Chat.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
