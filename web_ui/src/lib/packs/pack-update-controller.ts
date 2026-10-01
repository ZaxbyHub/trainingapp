// pack-update-controller.ts — the browser app's update channel controller,
// trace browser-training-parity AC8. It exposes the SAME surface as the
// desktop preload bridge's E5 methods (window.desktopApi getUpdateStatus /
// setUpdateOptIn / checkForUpdates / applyPackUpdate / onUpdateAvailable), so
// the Settings Updates section and the Packs panel render one UI for both
// apps; only the transport differs (desktop: main process; browser: this
// module, pack-update-browser.ts and the browser pack manager).
//
// Opt-in state persists in localStorage (PACK_UPDATES_STATE_KEY, a user
// setting Clear Cache removes); it defaults to OFF and nothing is fetched
// until the user opts in. Air-gapped builds refuse the opt-in.
import type { UpdateStatus } from '../../types/desktop';
import { IS_AIRGAP } from '../llm/airgap';
import { PACK_UPDATES_STATE_KEY } from '../storage/persisted-keys';
import { getBrowserPackManager, type BrowserPackManager } from './browser-pack-manager';
import {
  DEFAULT_UPDATE_FEED_URL,
  applyPackUpdate as applyVerifiedUpdate,
  downloadArtifactBytes,
  fetchFeedText,
  runUpdateCheck,
  type FeedVersionEntry,
  type TrustedKey,
  type UpdatesState,
} from './pack-update-browser';
import { updateFeedTrustedKeys } from './pack-policy';

export interface UpdateActionResult {
  ok: boolean;
  detail?: string;
  status?: UpdateStatus;
}

/** The E5 update surface shared by window.desktopApi and the browser controller. */
export interface UpdatesBridge {
  getUpdateStatus(): Promise<UpdateStatus>;
  setUpdateOptIn(enabled: boolean): Promise<UpdateActionResult>;
  checkForUpdates(): Promise<UpdateActionResult>;
  applyPackUpdate(packId: string): Promise<UpdateActionResult>;
  onUpdateAvailable(callback: (status: UpdateStatus) => void): () => void;
  openUpdateExternal?(url: string): Promise<{ ok: boolean; detail?: string }>;
}

export const AIRGAP_UPDATES_DETAIL = 'Update checks are not available in the air-gapped build (no network access).';

export interface BrowserUpdatesDeps {
  manager: () => Pick<BrowserPackManager, 'listPacks' | 'installPack'>;
  fetchFeed: (url: string) => Promise<string>;
  downloadArtifact: (url: string, expectedBytes: number) => Promise<Uint8Array>;
  trustedKeys: () => ReadonlyArray<TrustedKey>;
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | null;
  airgap: boolean;
  now: () => Date;
}

function readState(storage: Pick<Storage, 'getItem'> | null): UpdatesState {
  try {
    const raw = storage?.getItem(PACK_UPDATES_STATE_KEY);
    if (raw === null || raw === undefined) return { optIn: false };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { optIn?: unknown }).optIn !== 'boolean') {
      return { optIn: false };
    }
    const record = parsed as { optIn: boolean; feedUrl?: unknown };
    return typeof record.feedUrl === 'string' && record.feedUrl !== ''
      ? { optIn: record.optIn, feedUrl: record.feedUrl }
      : { optIn: record.optIn };
  } catch {
    return { optIn: false };
  }
}

export class BrowserUpdatesController implements UpdatesBridge {
  private status: UpdateStatus;
  private entries: Record<string, FeedVersionEntry> = {};
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private inFlight: Promise<UpdateActionResult> | null = null;
  private readonly applying = new Set<string>();

  constructor(private readonly deps: BrowserUpdatesDeps) {
    const state = deps.airgap ? { optIn: false } : readState(deps.storage());
    this.status = {
      optIn: state.optIn,
      feedUrl: state.feedUrl ?? DEFAULT_UPDATE_FEED_URL,
      checkedAt: null,
      candidates: [],
      refused: [],
      error: null,
      appUpdate: null,
      lastApply: null,
    };
  }

  private publish(next: UpdateStatus): UpdateStatus {
    this.status = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        /* a listener failure never breaks the controller */
      }
    }
    return next;
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    return this.status;
  }

  onUpdateAvailable(callback: (status: UpdateStatus) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async setUpdateOptIn(enabled: boolean): Promise<UpdateActionResult> {
    if (this.deps.airgap && enabled) return { ok: false, detail: AIRGAP_UPDATES_DETAIL, status: this.status };
    const storage = this.deps.storage();
    try {
      const current = readState(storage);
      storage?.setItem(PACK_UPDATES_STATE_KEY, JSON.stringify({ ...current, optIn: enabled }));
    } catch (error) {
      return { ok: false, detail: `could not save the updates setting: ${error instanceof Error ? error.message : String(error)}`, status: this.status };
    }
    const next = this.publish({
      ...this.status,
      optIn: enabled,
      ...(enabled ? {} : { candidates: [], refused: [], error: null, checkedAt: null }),
    });
    if (!enabled) {
      this.entries = {};
      return { ok: true, status: next };
    }
    // Desktop parity: enabling triggers one check.
    return this.checkForUpdates();
  }

  checkForUpdates(): Promise<UpdateActionResult> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(): Promise<UpdateActionResult> {
    const state: UpdatesState = this.deps.airgap ? { optIn: false } : readState(this.deps.storage());
    if (!state.optIn) {
      return { ok: false, detail: 'update checks are off; enable them first', status: this.status };
    }
    let installed: Array<{ packId: string; version: string }>;
    try {
      installed = (await this.deps.manager().listPacks()).map((p) => ({ packId: p.packId, version: p.version }));
    } catch (error) {
      installed = [];
      console.warn('[updates] could not list installed packs:', error);
    }
    const outcome = await runUpdateCheck(state, installed, { fetchFeed: this.deps.fetchFeed }, this.deps.trustedKeys());
    if (outcome.skipped) return { ok: false, detail: 'update checks are off; enable them first', status: this.status };
    this.entries = outcome.entries ?? {};
    const next = this.publish({
      ...this.status,
      optIn: true,
      feedUrl: state.feedUrl ?? DEFAULT_UPDATE_FEED_URL,
      checkedAt: this.deps.now().toISOString(),
      candidates: outcome.candidates,
      refused: outcome.refused,
      error: outcome.error ?? null,
    });
    return outcome.error !== undefined ? { ok: false, detail: outcome.error, status: next } : { ok: true, status: next };
  }

  async applyPackUpdate(packId: string): Promise<UpdateActionResult> {
    const candidate = this.status.candidates.find((c) => c.packId === packId);
    const entry = this.entries[packId];
    if (!this.status.optIn || candidate === undefined || entry === undefined) {
      return { ok: false, detail: `no verified update is pending for ${packId}`, status: this.status };
    }
    if (this.applying.has(packId)) return { ok: false, detail: `an update of ${packId} is already being applied`, status: this.status };
    this.applying.add(packId);
    try {
      const result = await applyVerifiedUpdate(
        candidate,
        entry,
        {
          downloadArtifact: this.deps.downloadArtifact,
          installPack: async (zipBytes, filename) => {
            const copy = new Uint8Array(zipBytes.byteLength);
            copy.set(zipBytes);
            const file = new File([copy], filename, { type: 'application/zip' });
            return this.deps.manager().installPack(file);
          },
        },
        this.deps.trustedKeys(),
      );
      const appliedAt = this.deps.now().toISOString();
      const lastApply = result.applied
        ? { packId, applied: true, version: result.version, appliedAt }
        : { packId, applied: false, reason: result.reason, appliedAt };
      const next = this.publish({
        ...this.status,
        candidates: result.applied ? this.status.candidates.filter((c) => c.packId !== packId) : this.status.candidates,
        lastApply,
      });
      if (result.applied) delete this.entries[packId];
      return result.applied ? { ok: true, status: next } : { ok: false, detail: result.reason, status: next };
    } finally {
      this.applying.delete(packId);
    }
  }
}

let controller: BrowserUpdatesController | null = null;

/** The browser app's update controller (lazily created). */
export function getBrowserUpdatesController(): BrowserUpdatesController {
  if (controller === null) {
    controller = new BrowserUpdatesController({
      manager: () => getBrowserPackManager(),
      fetchFeed: fetchFeedText,
      downloadArtifact: downloadArtifactBytes,
      trustedKeys: updateFeedTrustedKeys,
      storage: () => {
        try {
          return typeof localStorage === 'undefined' ? null : localStorage;
        } catch {
          return null;
        }
      },
      airgap: IS_AIRGAP,
      now: () => new Date(),
    });
  }
  return controller;
}

/** Tests only. */
export function resetBrowserUpdatesControllerForTests(next: BrowserUpdatesController | null = null): void {
  controller = next;
}

/**
 * The update surface for this app: the desktop preload bridge inside
 * Electron, the browser controller otherwise. One UI, two transports.
 */
export function getUpdatesBridge(): UpdatesBridge | undefined {
  if (typeof window !== 'undefined' && window.desktopApi !== undefined) {
    const bridge = window.desktopApi as unknown as Partial<UpdatesBridge>;
    // A bridge without the E5 methods (older main) has no update surface.
    return typeof bridge.getUpdateStatus === 'function' ? (bridge as UpdatesBridge) : undefined;
  }
  return getBrowserUpdatesController();
}
