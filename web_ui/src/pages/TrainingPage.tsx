/**
 * TrainingPage — the TRAINING tab surface: the embedded Articulate/Storyline
 * course player (issue #81, D5). Training packs are a DISTINCT product from
 * the knowledge-document packs (RAG content lives in Chat/Documents —
 * #133 feedback round 3): this tab lists and plays `training` source-class
 * packs only.
 *
 * The pack to open comes from the `pack` query parameter of the current
 * location (e.g. app://index.html?pack=opmed-cdp-mlc), with the Learn panel
 * (D6, issue #82) able to deep-link here: an `initialPackId` prop (lifted
 * navigation target from chat) takes precedence, and a `pendingSlideId` is
 * passed to the player as its initialSlideId so the auto-jump fires exactly
 * once, after the pack resolves. The picker lists INSTALLED training packs
 * (install path: a Storyline pack zip on the Documents page, or staged with
 * the installer), auto-selects the sole course, and remembers the last one.
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

const LAST_PACK_KEY = 'training.lastPackDir';

/** Managed pack directory path (`<packId>/<version>`) — the form the reserved
 * app://training route serves for PackManager-installed packs. */
const packDirKey = (pack: { packId: string; version: string }): string =>
  `${pack.packId}/${pack.version}`;

const isTrainingPack = (pack: PackInfo): boolean => pack.sourceClass === 'training';

export function TrainingPage({ initialPackId, pendingSlideId, onSlideChange }: TrainingPageProps) {
  const { session: desktopSession } = useDesktopSession();
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        if (!cancelled) setPacks(listing.filter(isTrainingPack));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [desktopSession, packs, loadError]);

  const activePacks = packs ?? [];
  // PRR-202: a MOUNTED Training tab must learn about packs installed after
  // mount — boot-ensure outcomes are console-only in the main process (no
  // packs-changed push), so refetch when the window regains focus. A refetch
  // failure keeps the current snapshot (never degrades to the empty state).
  useEffect(() => {
    if (desktopSession === null) return;
    const refetch = (): void => {
      void desktopSession.apiClient
        .listPacks()
        .then((listing: PackInfo[]) => {
          setPacks(listing.filter(isTrainingPack));
          setLoadError(null);
        })
        .catch(() => {
          // keep the current snapshot; the next focus retries
        });
    };
    window.addEventListener('focus', refetch);
    return () => window.removeEventListener('focus', refetch);
  }, [desktopSession]);
  // One row per COURSE (packId): installing a newer bundled version
  // deactivates the old one but keeps it on disk (#133 round 6 upgrade), and
  // listing both reads as a duplicate course. Prefer the active row, then the
  // highest version as a tiebreak (segment-aware so 1.0.10 > 1.0.9 — the
  // main process's semver comparator is the authority; this only orders a
  // same-active pair the dropdown rarely shows).
  const newerVersion = (a: string, b: string): string => {
    const segsA = a.split(/[.+-]/);
    const segsB = b.split(/[.+-]/);
    for (let i = 0; i < Math.max(segsA.length, segsB.length); i += 1) {
      const numA = Number(segsA[i]);
      const numB = Number(segsB[i]);
      if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) return numA > numB ? a : b;
      if ((segsA[i] ?? '') !== (segsB[i] ?? '')) return (segsA[i] ?? '') > (segsB[i] ?? '') ? a : b;
    }
    return a;
  };
  const courses = useMemo(() => {
    const byId = new Map<string, PackInfo>();
    for (const pack of activePacks) {
      const current = byId.get(pack.packId);
      if (current === undefined) {
        byId.set(pack.packId, pack);
        continue;
      }
      const preferred =
        pack.active !== current.active
          ? pack.active
            ? pack
            : current
          : newerVersion(pack.version, current.version) === pack.version
            ? pack
            : current;
      byId.set(pack.packId, preferred);
    }
    return [...byId.values()];
  }, [activePacks]);
  // A lifted target (D6/D7) or a ?pack= value that does not resolve to an
  // INSTALLED training pack is a course deep link by construction (the Learn
  // panel only emits training packs) — render the player for it directly,
  // without consulting the pack list (the frozen D7 wire contract; it must
  // work with no desktop session at all).
  // Reviewer R3 F3: with a session present, only deep-link once the pack
  // list has LOADED (before it resolves, some() is vacuously false and any
  // stale ?pack= would flash the player). Without a session there is no list
  // to wait for — the frozen D7 contract deep-links unconditionally.
  const urlPackIsKnownCourse =
    urlPack !== '' &&
    (activePacks.some((pack) => packDirKey(pack) === urlPack) ||
      courses.some((pack) => pack.packId === urlPack));
  // A bare pack ID (what the Learn panel emits) resolves to the installed
  // course's versioned dir key when one matches — #133 round 4 (bundled
  // course): the player needs <id>/<version>, the deep link says <id>.
  // Round-7 review finding 1: after a bundled upgrade the retired version's
  // row sorts FIRST for the id (listInstalled orders by id, version), so a
  // bare id must resolve through the DEDUPED course rows (active preferred) —
  // through activePacks it would play the retired version. An exact
  // <id>/<version> URL still honors the explicitly named version.
  const resolveDeepLink = (value: string): string => {
    if (value === '') return '';
    const byExact = activePacks.find((pack) => packDirKey(pack) === value);
    if (byExact !== undefined) return packDirKey(byExact);
    const byId = courses.find((pack) => pack.packId === value);
    return byId !== undefined ? packDirKey(byId) : value;
  };
  const deepLinkedPackDir =
    initialPackId !== undefined && initialPackId !== ''
      ? resolveDeepLink(initialPackId)
      : urlPack !== '' &&
          (desktopSession === null || packs !== null) &&
          !urlPackIsKnownCourse
        ? resolveDeepLink(urlPack)
        : '';
  const selectedPack = useMemo(() => {
    if (deepLinkedPackDir !== '') return undefined; // deep link bypasses the picker entirely
    if (urlPack !== '') {
      const byExact = activePacks.find((pack) => packDirKey(pack) === urlPack);
      if (byExact !== undefined) return byExact;
      const byId = courses.find((pack) => pack.packId === urlPack);
      if (byId !== undefined) return byId;
    }
    // Auto-select the sole course; with several, remember the last one —
    // matching the stored dir key first and, after a version upgrade retires
    // that dir, the same course's preferred (active) row.
    if (courses.length === 1) return courses[0];
    if (typeof window !== 'undefined' && courses.length > 1) {
      const last = window.localStorage.getItem(LAST_PACK_KEY);
      if (last !== null) {
        const byLast = courses.find((pack) => packDirKey(pack) === last);
        if (byLast !== undefined) return byLast;
        const lastId = last.split('/')[0] ?? '';
        const byLastId = courses.find((pack) => pack.packId === lastId);
        if (byLastId !== undefined) return byLastId;
      }
    }
    return undefined;
  }, [deepLinkedPackDir, urlPack, activePacks, courses]);

  const selectedDir =
    deepLinkedPackDir !== ''
      ? deepLinkedPackDir
      : selectedPack !== undefined
        ? packDirKey(selectedPack)
        : '';

  const selectPack = (dir: string): void => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (dir === '') url.searchParams.delete('pack');
    else url.searchParams.set('pack', dir);
    window.history.pushState({}, '', url);
    // Remember the course so the next visit auto-selects it (the LAST_PACK_KEY
    // read in the selection memo was write-less dead code until this —
    // round-7 review note).
    try {
      window.localStorage.setItem(LAST_PACK_KEY, dir);
    } catch {
      // storage may be unavailable (privacy mode); selection still works
    }
    setPackOverride(dir);
  };
  // History navigation (back/forward) mutates location.search without going
  // through selectPack — sync the override mirror so the URL and the picker
  // agree (PRR-203).
  useEffect(() => {
    const onPopState = (): void => {
      setPackOverride(new URLSearchParams(window.location.search).get('pack'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
        Training courses are available in the desktop app.
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
          Course:
        </label>
        <select
          id="training-pack-select"
          data-testid="training-pack-select"
          value={selectedDir}
          onChange={(event) => selectPack(event.target.value)}
          style={{ fontFamily: 'var(--font-family)', padding: 'var(--spacing-xs)' }}
        >
          <option value="">Select a course…</option>
          {courses.map((pack) => {
            const dir = packDirKey(pack);
            return (
              <option key={dir} value={dir}>
                {pack.name ?? pack.packId} ({dir})
              </option>
            );
          })}
        </select>
        {courses.length > 0 && (
          <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-muted)' }}>
            To update the course, install a newer training pack zip on the Documents page, then select it here.
          </span>
        )}
      </div>

      {loadError !== null && (
        <p role="alert" data-testid="training-pack-error" style={{ margin: 0, color: 'var(--color-danger, #d32f2f)' }}>
          Failed to load installed training packs: {loadError}
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
            flexDirection: 'column',
            gap: 'var(--spacing-sm)',
            textAlign: 'center',
            padding: '0 var(--spacing-xl)',
          }}
          data-testid="training-empty-state"
        >
          {packs === null ? (
            'Loading installed training packs…'
          ) : activePacks.length === 0 ? (
            <>
              <span>No training course is installed yet.</span>
              <span style={{ fontSize: 'var(--font-size-caption)' }}>
                Training courses are Articulate Storyline packs — a separate product from the reference
                documents (those live in Chat and Documents). Install a course pack zip from the Documents
                page, or ship one with the installer, and it will appear here ready to play.
              </span>
            </>
          ) : (
            'No course selected. Pick one above.'
          )}
        </div>
      ) : (
        <TrainingPlayer packId={selectedDir} initialSlideId={pendingSlideId} onSlideChange={onSlideChange} />
      )}
    </div>
  );
}
