// browser-training.ts — wiring of the browser app's course player
// (browser-training-parity, ADR-0012): the resolved player origin, the
// app-side relay host over the origin-private pack store, and the app-start
// hook that registers the player-origin service worker early. Inert inside
// the desktop app (app://training is served by the Electron main process).
import { isElectron } from '../desktop-session';
import { embedPendingPackChunks, getBrowserPackManager } from './browser-pack-manager';
import { getPlayerOrigin, isFramedContext, resolvePlayerOrigin } from './player-origin';
import { TrainingPlayerHost, getTrainingPlayerHost } from './training-player-host';

/** The browser course host, or null inside Electron / without a player origin. */
export function browserTrainingHost(): TrainingPlayerHost | null {
  if (typeof window === 'undefined' || isElectron()) return null;
  // Never in a framed app (review round 1, F1): no boot frame, no relay port.
  if (isFramedContext()) return null;
  const playerOrigin = getPlayerOrigin();
  if (playerOrigin === null) return null;
  return getTrainingPlayerHost(
    () =>
      new TrainingPlayerHost({
        playerOrigin,
        appOrigin: window.location.origin,
        readActiveFile: (packId, segments) => getBrowserPackManager().readActiveFile(packId, segments),
      }),
  );
}

/**
 * App start (browser app only): resolve the player origin once (bounded
 * runtime-config fetch), then embed the boot frame so the worker is usually
 * active before the first course opens.
 */
export async function startBrowserTraining(): Promise<void> {
  if (typeof window === 'undefined' || isElectron()) return;
  if (isFramedContext()) {
    console.warn('[training] course playback is disabled: this app is embedded in another page (open it in its own tab)');
    return;
  }
  // Pack chunks installed before the embedding model was ready are embedded
  // as soon as it is (resumable across reloads: the registry marks each
  // version once embedded).
  window.addEventListener('embedding-service-ready', (event) => {
    if ((event as CustomEvent<{ ready?: boolean }>).detail?.ready !== true) return;
    void embedPendingPackChunks().catch((error: unknown) => console.warn('[packs] embedding failed:', error));
  });
  const origin = await resolvePlayerOrigin();
  if (origin === null) return;
  const host = browserTrainingHost();
  if (host === null) return;
  void host.start();
}

/** The last installed pack is gone: drop the player-origin worker too. */
export async function releaseBrowserTrainingIfEmpty(): Promise<void> {
  if (typeof window === 'undefined' || isElectron()) return;
  const remaining = await getBrowserPackManager().listPacks();
  if (remaining.length === 0) browserTrainingHost()?.unregisterWorker();
}
