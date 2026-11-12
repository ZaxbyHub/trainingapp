/**
 * bundled-packs-boot.ts — the browser app's every-boot bundled-pack ensure
 * (issue #266, trace AC12-AC14).
 *
 * Desktop parity in shape (desktop/main/index.ts ensureBundledPacks +
 * first-run/bundled-packs.ts): each manifest entry is screened for
 * satisfaction FIRST and installed only when unsatisfied. The screen is
 * REQUIRED before installPack: browser-pack-manager's installPack throws on
 * an equal active version (browser-pack-manager.ts:258-260), so an
 * unconditional install would turn the every-boot ensure into a per-boot
 * failure for anyone who already has the pack.
 *
 * Satisfaction = an ACTIVE record for the id at the entry's version OR NEWER
 * (semver precedence via pack-manifest's comparator — a user-installed newer
 * pack satisfies the bundled entry, exactly like the desktop predicate).
 *
 * Guarantees (pinned by the bundled-packs-* specs):
 *   - every-boot, browser-only wiring is the CALLER's job (the BundledPacksBoot
 *     component skips Electron and framed contexts);
 *   - module-level SINGLE-FLIGHT (StrictMode-safe: the double-mounted effect
 *     joins one run);
 *   - per-pack failure isolation: one pack's failure never aborts the others
 *     and never throws out of the ensure; the caller's notice NAMES the pack;
 *   - post-error satisfaction re-check: an installPack that lost a race to a
 *     concurrent equal-version install (the throw above) counts as SUCCESS
 *     once the re-check sees the record;
 *   - the fetched zip is verified against the manifest's sha256 AND size
 *     before install (corruption/coverage verification of the staged artifact
 *     — explicitly NOT a hostile-host defense; a hostile host controls the
 *     manifest too. Transport integrity is the hosting requirement's job);
 *   - keyword-first ingestion + background vectors come from installPack's
 *     existing index hooks (browser-pack-manager searchIndexHooks), not from
 *     a second ingestion path here.
 */

import { compareVersions } from './pack-manifest';

/** One entry of the staged packs.manifest.json (written by prepare-packs.mjs). */
export interface BundledPackManifestEntry {
  id: string;
  version: string;
  /** Zip file name relative to the packs base URL. */
  file: string;
  /** SHA-256 hex of the zip. */
  sha256: string;
  /** Zip size in bytes. */
  size: number;
}

export interface BundledPacksManifest {
  packs: BundledPackManifestEntry[];
}

/** The pack-manager surface the ensure needs (BrowserPackManager satisfies it). */
export interface BundledPacksManagerSurface {
  activeRecords(): Promise<Array<{ packId: string; version: string }>>;
  installPack(file: Blob & { name: string }): Promise<{ packId: string; version: string }>;
}

export interface EnsureBundledPacksDeps {
  manager: BundledPacksManagerSurface;
  /** Same-origin manifest URL (default /packs/packs.manifest.json). */
  manifestUrl?: string;
  /** Base URL for the pack zips (default /packs/). */
  packsBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Polite status line: set when work starts, cleared (null) when it ends. */
  onStatus?: (text: string | null) => void;
  /** Per-pack failure notice; the message names the pack. */
  onPackFailure?: (packId: string, detail: string) => void;
}

export type BundledPackEnsureOutcome =
  | { id: string; outcome: 'satisfied'; version: string }
  | { id: string; outcome: 'installed'; version: string }
  | { id: string; outcome: 'recovered'; version: string }
  | { id: string; outcome: 'failed'; detail: string };

export interface EnsureBundledPacksResult {
  results: BundledPackEnsureOutcome[];
  /** Set when the manifest itself could not be fetched/parsed (no pack attempted). */
  manifestError?: string;
}

/**
 * #266 (review round 1 pin): browser app only, never Electron and never a
 * framed context — the desktop app's bundled-pack ensure lives in its main
 * process, and a framed app runs no pack lifecycle. Exported so the guard is
 * pinned by bundled-packs-boot.test.ts; the component consumes it.
 */
export function isBundledPacksBootEligible(
  scope: { desktopApi?: unknown; self: unknown } = window,
): boolean {
  if (scope.desktopApi !== undefined) return false;
  if (scope.self !== (scope.self as { top?: unknown }).top) return false;
  return true;
}

/** The polite status copy (surfaced through onStatus; pinned by the specs). */
export const BUNDLED_PACKS_STATUS_TEXT = 'Preparing knowledge packs…';

/**
 * Deploy-aware base for the bundled-pack staging, mirroring the models
 * manifest's resolveAbsoluteBase: `import.meta.env.BASE_URL` ('./' by
 * default) resolved against `document.baseURI` into an ABSOLUTE same-origin
 * pathname prefix, so subpath deployments (PACKAGING.md: serve from any
 * path) fetch `/docqa/packs/...` while origin-root stays `/packs/...`. The
 * fallback under a non-browser environment (tests) is the origin root.
 */
export function resolvePacksBase(): string {
  try {
    const resolved = new URL(import.meta.env.BASE_URL, document.baseURI).pathname;
    const clean = resolved.replace(/^\/+|\/+$/g, '');
    return clean === '' ? '/packs/' : `/${clean}/packs/`.replace(/\/{2,}/g, '/');
  } catch {
    return '/packs/';
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Desktop parity: an ACTIVE record at the entry's version OR NEWER satisfies. */
export function isBundledPackSatisfied(
  entry: Pick<BundledPackManifestEntry, 'id' | 'version'>,
  records: Array<{ packId: string; version: string }>,
): boolean {
  return records.some(
    (record) =>
      record.packId === entry.id && compareVersions(record.version, entry.version) >= 0,
  );
}

async function fetchBundledPackZip(
  entry: BundledPackManifestEntry,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(`${baseUrl}${entry.file}`, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`fetching ${entry.file} failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `${entry.file} size mismatch: manifest says ${entry.size} bytes, fetched ${bytes.byteLength}`,
    );
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new Error(`${entry.file} sha256 mismatch: manifest says ${entry.sha256}, fetched ${sha256}`);
  }
  return bytes;
}

async function runEnsure(deps: EnsureBundledPacksDeps): Promise<EnsureBundledPacksResult> {
  const {
    manager,
    // Defaults are deploy-aware (subpath hosting per PACKAGING.md); tests
    // inject explicit URLs.
    manifestUrl = `${resolvePacksBase()}packs.manifest.json`,
    packsBaseUrl = resolvePacksBase(),
    fetchImpl = fetch,
    onStatus,
    onPackFailure,
  } = deps;

  let manifest: BundledPacksManifest;
  try {
    const response = await fetchImpl(manifestUrl, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    manifest = (await response.json()) as BundledPacksManifest;
    if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.packs)) {
      throw new Error('no packs[] array');
    }
  } catch (error) {
    // No manifest means nothing is bundled for this deployment — the app
    // stays fully usable (packs can still be installed manually). Not a
    // per-pack failure; reported without naming a pack.
    return { results: [], manifestError: errorMessage(error) };
  }

  // Snapshot once (desktop PRR-211 parity): the all-satisfied fast path costs
  // one query; a throwing snapshot degrades to an empty set so every entry
  // falls into its own guarded install path.
  let installedRecords: Array<{ packId: string; version: string }> = [];
  try {
    installedRecords = await manager.activeRecords();
  } catch {
    installedRecords = [];
  }

  const results: BundledPackEnsureOutcome[] = [];
  let statusRaised = false;
  for (const entry of manifest.packs) {
    let satisfied = isBundledPackSatisfied(entry, installedRecords);
    if (satisfied) {
      results.push({ id: entry.id, outcome: 'satisfied', version: entry.version });
      continue;
    }
    if (!statusRaised) {
      statusRaised = true;
      onStatus?.(BUNDLED_PACKS_STATUS_TEXT);
    }
    try {
      const bytes = await fetchBundledPackZip(entry, packsBaseUrl, fetchImpl);
      const blob = Object.assign(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        name: entry.file,
      }) as Blob & { name: string };
      const installed = await manager.installPack(blob);
      // Refresh the snapshot so a later entry's screen stays correct.
      try {
        installedRecords = await manager.activeRecords();
      } catch {
        installedRecords = [];
      }
      results.push({ id: installed.packId ?? entry.id, outcome: 'installed', version: installed.version ?? entry.version });
    } catch (error) {
      // Post-error satisfaction re-check: a concurrent equal-version install
      // (installPack throws on an equal ACTIVE version) means the pack IS
      // present — that is success, not failure.
      try {
        const after = await manager.activeRecords();
        if (isBundledPackSatisfied(entry, after)) {
          installedRecords = after;
          results.push({ id: entry.id, outcome: 'recovered', version: entry.version });
          continue;
        }
      } catch {
        // fall through to the named failure
      }
      const detail = errorMessage(error);
      onPackFailure?.(entry.id, detail);
      results.push({ id: entry.id, outcome: 'failed', detail });
    }
  }
  if (statusRaised) onStatus?.(null);
  return { results };
}

/** Module-level single-flight: concurrent callers join the running ensure. */
let bundledBootInFlight: Promise<EnsureBundledPacksResult> | null = null;

/**
 * Ensure every bundled pack in the staged manifest is installed (screened
 * BEFORE installPack; per-pack isolation; never throws).
 */
export function ensureBundledPacksInBrowser(
  deps: EnsureBundledPacksDeps,
): Promise<EnsureBundledPacksResult> {
  if (bundledBootInFlight !== null) return bundledBootInFlight;
  const run = runEnsure(deps).finally(() => {
    if (bundledBootInFlight === run) bundledBootInFlight = null;
  });
  bundledBootInFlight = run;
  return run;
}

/** Tests only: clear the single-flight so each spec gets a fresh run. */
export function resetBundledPacksBootForTests(): void {
  bundledBootInFlight = null;
}
