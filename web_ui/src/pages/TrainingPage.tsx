/**
 * TrainingPage — the TRAINING tab surface: the embedded Articulate/Storyline
 * course player (issue #81, D5). Training packs are a DISTINCT product from
 * the knowledge-document packs (RAG content lives in Chat/Documents —
 * #133 feedback round 3): this tab lists and plays `training` source-class
 * packs only.
 *
 * Both apps (browser-training-parity, ADR-0012 superseding ADR-0009's
 * desktop-only notice): the installed packs come from the PackClient seam —
 * the desktop loopback pack API inside Electron, the origin-private browser
 * pack store otherwise — and the player loads from app://training (desktop)
 * or the dedicated player origin (browser).
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TrainingPlayer, courseIdOf } from '../components/TrainingPlayer';
import type { TrainingPlayerSlideState } from '../components/training-player-bridge';
import { usePackClient } from '../lib/packs/pack-client';
import { LAST_PACK_KEY } from '../lib/storage/persisted-keys';
import type { PackInfo } from '../lib/api/types';
import {
  advanceCourseProgress,
  courseProgressView,
  loadCourseProgress,
  mergeCourseProgress,
  saveCourseProgress,
  subscribeCourseProgress,
  type CourseProgress,
} from '../lib/training/course-progress';
import { courseSlideCount, slideDocsAvailable, slidePosition } from '../lib/training/slide-position';
import { isElectron } from '../lib/desktop-session';
import { Badge, Button, Icon, PageHeader, ProgressBar, Select } from '../ui';
import './training.css';

const TRAINING_DESCRIPTION = 'Play the training courses installed on this device.';

export interface TrainingPageProps {
  /** D6 (issue #82): pack from the lifted chat navigation target. */
  initialPackId?: string;
  /** D6 (issue #82): slide to jump to once a pack is open. */
  pendingSlideId?: string;
  /**
   * D7 (issue #83): receives the player's slidechange event VERBATIM — the
   * frozen `{slideId, slideTitle}` payload reaches the caller (App, which owns
   * the pinned-slide state) unchanged. Do not decorate the event here.
   * Called once per player slidechange, and (Lumen phase 6) once more with the
   * SAME event object each time the user presses "Pin slide to Chat" — App pins
   * every slidechange already, so a re-forward only restores a pin the user
   * dismissed in Chat; it never carries a new or modified payload.
   */
  onSlideChange?: (event: TrainingPlayerSlideState) => void;
  /**
   * Lumen phase 6: the player page's Back releases a lifted chat deep link
   * (App owns `initialPackId`), so the library and any course picked from it
   * take over. Optional: without it Back still shows the library.
   */
  onLeaveDeepLink?: () => void;
}


/** Managed pack directory path (`<packId>/<version>`) — the form the reserved
 * app://training route serves for PackManager-installed packs. */
const packDirKey = (pack: { packId: string; version: string }): string =>
  `${pack.packId}/${pack.version}`;

/** Browser-only slide-docs readiness poll cap (1s interval, ~1 minute). */
const SLIDE_DOCS_POLL_MAX = 60;

const isTrainingPack = (pack: PackInfo): boolean => pack.sourceClass === 'training';

export function TrainingPage({ initialPackId, pendingSlideId, onSlideChange, onLeaveDeepLink }: TrainingPageProps) {
  const packClient = usePackClient();
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // ?pack= is read from the location ONCE plus on explicit picker changes —
  // a plain memo would not see pushState, so an override state mirrors it.
  const [packOverride, setPackOverride] = useState<string | null>(null);
  // PRE-c: the user explicitly chose "Select a course..." — the sole-course /
  // remembered-course auto-select must not win straight back (snap-back). A plain
  // packOverride of '' cannot carry this: it is the same string the location
  // yields with no ?pack=, so the selection memo would not even re-run.
  const [deselected, setDeselected] = useState(false);
  // Lumen phase 6: the player page's Back shows the course library even when a
  // course is selected (with a sole course the picker auto-selects it, so the
  // library needs an explicit flag). Cleared by any course choice.
  const [libraryRequested, setLibraryRequested] = useState(false);
  // The slide the player last reported (for the header and pin-slide). Each
  // player event is forwarded to onSlideChange UNCHANGED, one call per event
  // (D7 contract); pinning a slide re-forwards the current slide on request.
  const [currentSlide, setCurrentSlide] = useState<TrainingPlayerSlideState | null>(null);
  // Polite confirmation for the Pin button (the pin itself shows up in Chat).
  const [pinAnnouncement, setPinAnnouncement] = useState('');
  // Furthest slide reached per course (persisted; drives the course-card progress).
  const [progress, setProgress] = useState<CourseProgress>(() => loadCourseProgress());
  // Storage is the shared truth across tabs (PRR-203/206): fold in what another tab
  // records (an idle tab would otherwise never see it), and drop everything when the
  // progress is cleared (Clear Cache in any tab) so cleared progress is neither shown
  // nor merged back into storage by this tab's next slide change.
  useEffect(
    () =>
      subscribeCourseProgress((stored) =>
        setProgress((current) =>
          stored === null ? (Object.keys(current).length === 0 ? current : {}) : mergeCourseProgress(current, stored)
        )
      ),
    []
  );
  // Slide docs live in the browser keyword index, which initializes after boot
  // and exposes no ready event: poll until ready so slide counts and "x of n"
  // appear without a remount. Never in the desktop renderer (no browser index).
  // Bounded: gives up after SLIDE_DOCS_POLL_MAX attempts (~1 minute) so an index
  // that never becomes ready does not poll for the life of the page — but it is
  // RE-ARMED (PRR-202) whenever the window regains focus or becomes visible, so a
  // slow first index build recovers the counts without a remount.
  const [slideDocsReady, setSlideDocsReady] = useState(() => !isElectron() && slideDocsAvailable());
  const [pollEpoch, setPollEpoch] = useState(0);
  useEffect(() => {
    if (slideDocsReady || isElectron()) return undefined;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (slideDocsAvailable()) setSlideDocsReady(true);
      else if (attempts >= SLIDE_DOCS_POLL_MAX) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [slideDocsReady, pollEpoch]);
  useEffect(() => {
    if (slideDocsReady || isElectron()) return undefined;
    const rearm = (): void => {
      if (document.visibilityState === 'hidden') return;
      if (slideDocsAvailable()) setSlideDocsReady(true);
      else setPollEpoch((epoch) => epoch + 1);
    };
    window.addEventListener('focus', rearm);
    document.addEventListener('visibilitychange', rearm);
    return () => {
      window.removeEventListener('focus', rearm);
      document.removeEventListener('visibilitychange', rearm);
    };
  }, [slideDocsReady]);
  // A new lifted deep link (chat "Open in training") always opens its player.
  // Only a SET target counts: Back clears it (onLeaveDeepLink), and resetting
  // here on that clear would let the picker auto-select the sole or remembered
  // course and reopen a player the user just left (phase-6 review H1).
  useEffect(() => {
    if (initialPackId) setLibraryRequested(false);
  }, [initialPackId]);

  const urlPack = useMemo(() => {
    if (initialPackId !== undefined && initialPackId !== '') return initialPackId;
    if (packOverride !== null) return packOverride;
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('pack') ?? '';
  }, [initialPackId, packOverride]);

  useEffect(() => {
    if (packClient === null) return;
    // Load-once: the pack set only changes through installs/removals on the
    // Documents page — refreshed by re-entering the tab (and, in the browser
    // app, by the store's change notifications below).
    if (packs !== null || loadError !== null) return;
    let cancelled = false;
    void packClient
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
  }, [packClient, packs, loadError]);

  const activePacks = packs ?? [];
  // PRR-202: a MOUNTED Training tab must learn about packs installed after
  // mount — boot-ensure outcomes are console-only in the main process (no
  // packs-changed push), so refetch when the window regains focus. A refetch
  // failure keeps the current snapshot (never degrades to the empty state).
  useEffect(() => {
    if (packClient === null) return;
    const refetch = (): void => {
      void packClient
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
    const unsubscribe = packClient.subscribe?.(refetch);
    return () => {
      window.removeEventListener('focus', refetch);
      unsubscribe?.();
    };
  }, [packClient]);
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
          (packClient === null || packs !== null || loadError !== null) &&
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
    if (deselected) return undefined;
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
  }, [deepLinkedPackDir, urlPack, activePacks, courses, deselected]);

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
    window.history.pushState(dir === '' ? { trainingDeselected: true } : {}, '', url);
    // Remember the course so the next visit auto-selects it (the LAST_PACK_KEY
    // read in the selection memo was write-less dead code until this —
    // round-7 review note).
    try {
      window.localStorage.setItem(LAST_PACK_KEY, dir);
    } catch {
      // storage may be unavailable (privacy mode); selection still works
    }
    setPackOverride(dir);
    setDeselected(dir === '');
    setLibraryRequested(false);
  };
  // History navigation (back/forward) mutates location.search without going
  // through selectPack — sync the override mirror so the URL and the picker
  // agree (PRR-203).
  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      setPackOverride(new URLSearchParams(window.location.search).get('pack'));
      setDeselected((event.state as { trainingDeselected?: boolean } | null)?.trainingDeselected === true);
      setLibraryRequested(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // ---- Lumen phase 6: library grid + player page (slim header) ----
  const playerDir = deepLinkedPackDir !== '' ? deepLinkedPackDir : selectedDir;
  const showPlayer = playerDir !== '' && !libraryRequested;
  const playerCourseId = courseIdOf(playerDir);
  const playerCourse = courses.find((pack) => packDirKey(pack) === playerDir || pack.packId === playerDir);

  // A different course starts with no observed slide.
  useEffect(() => {
    setCurrentSlide(null);
  }, [playerDir]);

  // Every player event is forwarded UNCHANGED (D7); the page additionally records
  // the furthest position reached, only when the position is KNOWN (slide docs ready).
  const handleSlideChange = useCallback(
    (event: TrainingPlayerSlideState) => {
      setCurrentSlide(event);
      setPinAnnouncement('');
      if (slideDocsReady) {
        const reached = slidePosition(playerCourseId, event.slideId);
        if (reached !== null) {
          // Storage is the shared truth across tabs: re-read it so another tab's
          // progress (for any course) is kept, raise only this course, and write
          // back. The state update is functional (and pure) so a burst of events
          // never works from a stale closure.
          const stored = loadCourseProgress();
          const next = advanceCourseProgress(stored, playerCourseId, reached.index);
          if (next !== stored) saveCourseProgress(next);
          setProgress((current) => mergeCourseProgress(current, next));
        }
      }
      onSlideChange?.(event);
    },
    [onSlideChange, slideDocsReady, playerCourseId]
  );

  // "Slide x of n" from the course's ingested slide docs; the title alone when
  // they are not available (desktop renderer, index not ready). Never guessed.
  const position = useMemo(
    () => (currentSlide === null || !slideDocsReady ? null : slidePosition(playerCourseId, currentSlide.slideId)),
    [currentSlide, playerCourseId, slideDocsReady]
  );
  const slideLabel =
    currentSlide === null
      ? 'Start the course to see your slide'
      : position !== null
        ? `Slide ${position.index} of ${position.total} · ${currentSlide.slideTitle}`
        : `Slide: ${currentSlide.slideTitle}`;

  // Course cards: no cover art exists on an installed pack, so the card shows a
  // monogram tile, the slide count and the learner's progress (furthest slide
  // reached, course-progress.ts: "Reached slide k of n", NOT a completion count, since a
  // deep link can land on slide 30 without slides 1-29 being seen) when the ingested slide
  // docs give the count, and
  // "Last opened" (LAST_PACK_KEY) as secondary text. Progress needs a known count:
  // without one (desktop, index not ready) the card shows neither number.
  const lastOpenedId = (() => {
    if (typeof window === 'undefined') return '';
    try {
      return (window.localStorage.getItem(LAST_PACK_KEY) ?? '').split('/')[0] ?? '';
    } catch {
      return '';
    }
  })();
  const slideCounts = useMemo(
    () =>
      new Map(
        courses.map((pack) => [pack.packId, slideDocsReady ? courseSlideCount(pack.packId) : null] as const)
      ),
    [courses, slideDocsReady]
  );

  // PRE-d: a deep link to a course that is not installed (list loaded, no row for
  // the id) or to a slide that course does not have used to open a silent blank
  // player. The player still renders (frozen D7 contract: deep links play without
  // consulting the list), but the page now says what is wrong and offers the way
  // back. Known only when the list loaded; the slide check needs the ingested
  // slide docs (never claimed where positions are unknown).
  const deepLinkCourseMissing =
    showPlayer &&
    deepLinkedPackDir !== '' &&
    packs !== null &&
    !courses.some((pack) => pack.packId === playerCourseId);
  const deepLinkSlideMissing =
    showPlayer &&
    !deepLinkCourseMissing &&
    initialPackId !== undefined &&
    initialPackId !== '' &&
    pendingSlideId !== undefined &&
    pendingSlideId !== '' &&
    slideDocsReady &&
    courseSlideCount(playerCourseId) !== null &&
    slidePosition(playerCourseId, pendingSlideId) === null;

  const backToLibrary = (): void => {
    // A lifted chat deep link lives in App: release it so the library (and a
    // course picked from it) is what this page shows next.
    if (initialPackId !== undefined && initialPackId !== '') onLeaveDeepLink?.();
    setLibraryRequested(true);
  };

  // ONE tree for both views: the course picker keeps its position (and so its
  // DOM node) when the library turns into the player page and back.
  const deepLinked = deepLinkedPackDir !== '';
  return (
    <div className="app-page">
      {/* Header (Lumen phase 3): the shared PageHeader on both views; slim (no description) on the player page, H1 kept. */}
      <PageHeader title="Training" description={showPlayer ? undefined : TRAINING_DESCRIPTION} />
      <div
        className={showPlayer ? 'app-page__fill app-training app-training--player' : 'app-training'}
        data-testid={showPlayer && deepLinked ? undefined : 'training-page'}
      >
        {/* Library: picker toolbar. Player page: the slim header (back, course
            title = the picker itself, version, slide x of n, pin-slide). */}
        <div className={showPlayer ? 'app-training__playerbar' : 'app-training__toolbar'}>
          {showPlayer ? (
            <Button size="sm" variant="ghost" onClick={backToLibrary}>
              <Icon name="chevron-left" size={16} />
              All courses
            </Button>
          ) : null}
          {showPlayer && deepLinked ? (
            <h2 className="app-training__title">{playerCourse?.name ?? playerCourseId}</h2>
          ) : (
            <>
              <label
                htmlFor="training-pack-select"
                className={showPlayer ? 'ui-visually-hidden' : 'app-training__label'}
              >
                {showPlayer ? 'Course' : 'Course:'}
              </label>
              <Select
                id="training-pack-select"
                data-testid="training-pack-select"
                className={showPlayer ? 'app-training__title-select' : 'app-training__select'}
                value={selectedDir}
                onChange={(event) => selectPack(event.target.value)}
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
              </Select>
            </>
          )}
          {showPlayer && playerCourse !== undefined ? <Badge>v{playerCourse.version}</Badge> : null}
          {showPlayer ? <span className="app-training__slidepos">{slideLabel}</span> : null}
          {showPlayer ? (
            <Button
              size="sm"
              variant="secondary"
              className="app-training__pin"
              aria-disabled={currentSlide === null || undefined}
              onClick={() => {
                // Re-forwards the SAME event object the player emitted (App pins
                // every slide change already; this restores a dismissed pin).
                if (currentSlide === null) return;
                onSlideChange?.(currentSlide);
                setPinAnnouncement('Slide pinned to Chat');
              }}
            >
              <Icon name="message-square" size={16} />
              Pin slide to Chat
            </Button>
          ) : null}
          {showPlayer ? (
            <span role="status" className="ui-visually-hidden">
              {pinAnnouncement}
            </span>
          ) : null}
          {!showPlayer && courses.length > 0 ? (
            <p className="app-training__hint">
              To update the course, install a newer training pack zip on the Documents page, then select it here.
            </p>
          ) : null}
        </div>

        {!(showPlayer && deepLinked) && loadError !== null && (
          <p role="alert" data-testid="training-pack-error" className="ui-banner ui-banner--danger app-training__error">
            Failed to load installed training packs: {loadError}
          </p>
        )}

        {deepLinkCourseMissing ? (
          <p role="status" data-testid="training-deeplink-missing" className="ui-banner ui-banner--warning app-training__error">
            The linked course ({playerCourseId}) is not installed on this device. Install its training pack zip on the
            Documents page, or pick one of the installed courses.{' '}
            <Button size="sm" variant="secondary" onClick={backToLibrary}>
              Show all courses
            </Button>
          </p>
        ) : null}
        {deepLinkSlideMissing ? (
          <p role="status" data-testid="training-deeplink-slide-missing" className="ui-banner ui-banner--warning app-training__error">
            The linked slide was not found in this course (it may have changed in an update), so the course opens
            without jumping to it.
          </p>
        ) : null}
        {showPlayer ? (
          <TrainingPlayer packId={playerDir} initialSlideId={pendingSlideId} onSlideChange={handleSlideChange} />
        ) : packs === null || courses.length === 0 ? (
          <div className="ui-empty app-training__empty" data-testid="training-empty-state">
            {packs === null ? (
              <p className="ui-empty__desc">Loading installed training packs…</p>
            ) : (
              <>
                <Icon name="layers" size={32} className="ui-empty__icon" />
                <h2 className="ui-empty__title">No training course is installed yet.</h2>
                <p className="ui-empty__desc">
                  Training courses are Articulate Storyline packs — a separate product from the reference
                  documents (those live in Chat and Documents). Install a course pack zip from the Documents
                  page, or ship one with the installer, and it will appear here ready to play.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="app-training__grid" aria-label="Installed courses">
            {courses.map((pack) => {
              const dir = packDirKey(pack);
              const title = pack.name ?? pack.packId;
              const slides = slideCounts.get(pack.packId) ?? null;
              const view = courseProgressView(progress, pack.packId, slides);
              return (
                <li key={dir} className="app-training__grid-item">
                  <button
                    type="button"
                    className="app-course ui-focusable"
                    data-testid={`training-course-${pack.packId}`}
                    onClick={() => selectPack(dir)}
                  >
                    <span className="app-course__cover" aria-hidden="true">
                      <Icon name="layers" size={28} />
                      <span className="app-course__monogram">{monogram(title)}</span>
                    </span>
                    <span className="app-course__body">
                      <span className="app-course__title">{title}</span>
                      <span className="app-course__meta">
                        {slides !== null ? `${slides} slide${slides === 1 ? '' : 's'}` : 'Storyline course'}
                      </span>
                      {view !== null ? (
                        <span className="app-course__progress">
                          {/* Decorative inside the card button: a progressbar there still
                              contributes its raw value to the button's name (Chromium), so the
                              visible text below is the single source of the progress. */}
                          <span className="app-course__bar" aria-hidden="true">
                            <ProgressBar
                              label={
                                view.reached === 0
                                  ? `${title} progress: not started`
                                  : `${title} progress: reached slide ${view.reached} of ${view.total}`
                              }
                              value={view.reached}
                              max={view.total}
                            />
                          </span>
                          <span className="app-course__progress-text">
                            {view.reached === 0 ? 'Not started' : `Reached slide ${view.reached} of ${view.total}`}
                          </span>
                        </span>
                      ) : null}
                      <span className="app-course__badges">
                        <Badge>v{pack.version}</Badge>
                        {lastOpenedId === pack.packId && <Badge tone="accent">Last opened</Badge>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Two-letter monogram for the generated course cover (no cover art exists). */
function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
