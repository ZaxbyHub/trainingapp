// pack-update-browser.ts — the browser twin of the desktop signed update
// channel for knowledge packs (desktop/main/update-checker.ts, ADR-0010),
// trace browser-training-parity AC8.
//
// Same contract as desktop:
//   * OPT-IN: runUpdateCheck performs ZERO network activity until the user
//     opted in; the gate precedes even reading the feed URL.
//   * Feed-level trust: every version entry is Ed25519-signed over the
//     artifact's lowercase sha256 hex (UTF-8); entries are verified against
//     the BUILD-TIME trust anchor (pack-policy.ts updateFeedTrustedKeys);
//     there is no unsigned fallback.
//   * The feed document must satisfy contracts/pack-feed.schema.json
//     (mirrored here by hand — desktop/src/__tests__/browser-pack-schema-drift.test.ts
//     pins the mirror to ajv on the real schema).
//   * A verified artifact installs through the SAME install path as a
//     user-picked zip (browser-pack-manager.ts installPack), so every archive
//     guard, manifest gate and the signature policy apply unchanged.
// Browser-only constraints (ADR-0012): the feed and artifact hosts must send
// CORS headers (a GitHub Releases redirect does not, so the default feed
// needs a CORS-enabled mirror or the desktop app); intermediate redirect hops
// cannot be inspected by the fetch API, so only the FINAL URL is required to
// be https (the sha256 + Ed25519 gate stays the final arbiter). Air-gapped
// builds (VITE_AIRGAP=1) compile the network path out entirely.
import { IS_AIRGAP } from '../llm/airgap';
import { isDateTime, sha256Hex } from './pack-manifest';
import { decodeBase64Lenient, verifyEd25519, type TrustedPackKey } from './pack-verify';

export type TrustedKey = TrustedPackKey;

export interface FeedVersionEntry {
  version: string;
  published_at: string;
  sha256: string;
  size_bytes: number;
  download_url: string;
  supersedes?: string[];
  signature?: { algorithm: string; key_id: string; value: string };
}

export interface FeedPackEntry {
  pack_id: string;
  versions: FeedVersionEntry[];
}

export interface PackFeedDocument {
  schema_version: number;
  generated_at?: string;
  packs: FeedPackEntry[];
}

export interface PackUpdateCandidate {
  packId: string;
  currentVersion: string;
  availableVersion: string;
  publishedAt: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
}

export interface UpdatesState {
  optIn: boolean;
  feedUrl?: string;
}

export interface UpdateCheckDeps {
  fetchFeed: (url: string) => Promise<string>;
}

export type UpdateCheckOutcome =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      candidates: PackUpdateCandidate[];
      refused: Array<{ packId: string; version: string; reason: string }>;
      error?: string;
      entries?: Record<string, FeedVersionEntry>;
    };

export interface VerificationResult {
  ok: boolean;
  detail?: string;
}

/** Same default feed location as desktop (DEFAULT_UPDATE_FEED_URL). */
export const DEFAULT_UPDATE_FEED_URL =
  'https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json';

/** Desktop MAX_PACK_ARTIFACT_BYTES: the feed schema's size_bytes ceiling (50 MiB). */
export const MAX_PACK_ARTIFACT_BYTES = 52_428_800;
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_TIMEOUT_MS = 15_000;
const ARTIFACT_TIMEOUT_MS = 120_000;

// --------------------------------------------------------------------- //
// semver ordering (mirror of desktop update-checker parseVersionKey)
// --------------------------------------------------------------------- //

interface FeedVersionKey {
  major: number;
  minor: number;
  patch: number;
  pre: number;
  preIds: Array<string | number>;
}

export function parseVersionKey(version: string): FeedVersionKey | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  const preIds: Array<string | number> = [];
  if (match[4] !== undefined) {
    for (const id of match[4].split('.')) preIds.push(/^\d+$/.test(id) ? Number(id) : id);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] === undefined ? 1 : 0, preIds };
}

function comparePreIds(a: Array<string | number>, b: Array<string | number>): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i];
    const right = b[i];
    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) return left - right;
    } else if (typeof left === 'string' && typeof right === 'string') {
      if (left !== right) return left < right ? -1 : 1;
    } else {
      return typeof left === 'number' ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function compareFeedVersionKeys(a: FeedVersionKey, b: FeedVersionKey): number {
  for (const field of ['major', 'minor', 'patch', 'pre'] as const) {
    if (a[field] !== b[field]) return a[field] - b[field];
  }
  return comparePreIds(a.preIds, b.preIds);
}

function currentInstalledVersion(installed: ReadonlyArray<{ packId: string; version: string }>, packId: string): string | null {
  let bestKey: FeedVersionKey | null = null;
  let bestVersion: string | null = null;
  for (const record of installed) {
    if (record.packId !== packId) continue;
    const key = parseVersionKey(record.version);
    if (key === null) continue;
    if (bestKey === null || compareFeedVersionKeys(key, bestKey) > 0) {
      bestKey = key;
      bestVersion = record.version;
    }
  }
  return bestVersion;
}

function mergeFeedPacks(feed: PackFeedDocument): FeedPackEntry[] {
  const byId = new Map<string, FeedPackEntry>();
  for (const feedPack of feed.packs) {
    const existing = byId.get(feedPack.pack_id);
    if (existing === undefined) byId.set(feedPack.pack_id, { pack_id: feedPack.pack_id, versions: [...feedPack.versions] });
    else existing.versions.push(...feedPack.versions);
  }
  return [...byId.values()];
}

function bestVersionEntry(versions: ReadonlyArray<FeedVersionEntry>, currentVersion: string): FeedVersionEntry | null {
  const currentKey = parseVersionKey(currentVersion);
  if (currentKey === null) return null;
  let best: FeedVersionEntry | null = null;
  let bestKey: FeedVersionKey | null = null;
  for (const entry of versions) {
    const entryKey = parseVersionKey(entry.version);
    if (entryKey === null) continue;
    if (compareFeedVersionKeys(entryKey, currentKey) <= 0) continue;
    if (bestKey === null || compareFeedVersionKeys(entryKey, bestKey) > 0) {
      best = entry;
      bestKey = entryKey;
    }
  }
  return best;
}

// --------------------------------------------------------------------- //
// contracts/pack-feed.schema.json mirror
// --------------------------------------------------------------------- //

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SUPERSEDES_RE = /^[a-z0-9][a-z0-9-]{0,198}@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u;
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,198}$/u;
const HTTPS_URL_RE = /^https:\/\/[!-~]+$/u;
const SIG_VALUE_RE = /^[A-Za-z0-9+/]+={0,2}$/u;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const codePoints = (v: string): number => Array.from(v).length;
const hasOnly = (v: Json, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));
const hasAll = (v: Json, required: readonly string[]): boolean => required.every((k) => Object.prototype.hasOwnProperty.call(v, k));

function validSignatureBlock(v: unknown): boolean {
  return (
    isObject(v) &&
    hasAll(v, ['algorithm', 'key_id', 'value']) &&
    hasOnly(v, ['algorithm', 'key_id', 'value']) &&
    v.algorithm === 'ed25519' &&
    isString(v.key_id) &&
    codePoints(v.key_id) >= 1 &&
    codePoints(v.key_id) <= 200 &&
    isString(v.value) &&
    SIG_VALUE_RE.test(v.value)
  );
}

function validVersionEntry(v: unknown, maxSize: number, extraAllowed: readonly string[]): boolean {
  const required = ['version', 'published_at', 'sha256', 'size_bytes', 'download_url', 'signature'];
  if (!isObject(v) || !hasAll(v, required) || !hasOnly(v, [...required, ...extraAllowed])) return false;
  if (!isString(v.version) || !SEMVER_RE.test(v.version)) return false;
  if (!isString(v.published_at) || !isDateTime(v.published_at)) return false;
  if (!isString(v.sha256) || !SHA256_RE.test(v.sha256)) return false;
  if (!isInteger(v.size_bytes) || v.size_bytes < 1 || v.size_bytes > maxSize) return false;
  if (!isString(v.download_url) || !HTTPS_URL_RE.test(v.download_url)) return false;
  if (!validSignatureBlock(v.signature)) return false;
  if ('supersedes' in v) {
    if (!Array.isArray(v.supersedes) || !v.supersedes.every((s) => isString(s) && SUPERSEDES_RE.test(s))) return false;
  }
  if ('notes_url' in v && (!isString(v.notes_url) || !HTTPS_URL_RE.test(v.notes_url))) return false;
  return true;
}

/** True iff ajv would accept `parsed` against contracts/pack-feed.schema.json. */
export function validateFeedDocument(parsed: unknown): { ok: boolean; detail?: string } {
  const bad = { ok: false, detail: 'feed document does not satisfy contracts/pack-feed.schema.json' };
  if (!isObject(parsed) || !hasAll(parsed, ['schema_version', 'packs']) || !hasOnly(parsed, ['schema_version', 'generated_at', 'packs', 'app'])) {
    return bad;
  }
  if (!isInteger(parsed.schema_version) || parsed.schema_version !== 1) return bad;
  if ('generated_at' in parsed && (!isString(parsed.generated_at) || !isDateTime(parsed.generated_at))) return bad;
  if (!Array.isArray(parsed.packs)) return bad;
  for (const pack of parsed.packs) {
    if (!isObject(pack) || !hasAll(pack, ['pack_id', 'versions']) || !hasOnly(pack, ['pack_id', 'versions'])) return bad;
    if (!isString(pack.pack_id) || !PACK_ID_RE.test(pack.pack_id)) return bad;
    if (!Array.isArray(pack.versions) || !pack.versions.every((e) => validVersionEntry(e, MAX_PACK_ARTIFACT_BYTES, ['supersedes']))) return bad;
  }
  if ('app' in parsed) {
    const app = parsed.app;
    if (!isObject(app) || !hasAll(app, ['versions']) || !hasOnly(app, ['versions'])) return bad;
    if (!Array.isArray(app.versions) || !app.versions.every((e) => validVersionEntry(e, 8589934592, ['notes_url']))) return bad;
  }
  return { ok: true };
}

// --------------------------------------------------------------------- //
// signature + artifact verification (desktop wording)
// --------------------------------------------------------------------- //

export async function verifyFeedEntrySignature(entry: FeedVersionEntry, trustedKeys: ReadonlyArray<TrustedKey>): Promise<VerificationResult> {
  const signature = entry.signature;
  if (
    signature === undefined ||
    signature === null ||
    typeof signature !== 'object' ||
    typeof signature.algorithm !== 'string' ||
    typeof signature.key_id !== 'string' ||
    typeof signature.value !== 'string'
  ) {
    return { ok: false, detail: 'feed entry carries no signature block; the update feed has no unsigned fallback' };
  }
  if (signature.algorithm !== 'ed25519') {
    return { ok: false, detail: `unsupported signature algorithm '${signature.algorithm}'; only ed25519 is trusted` };
  }
  const trusted = trustedKeys.find((key) => key.key_id === signature.key_id);
  if (trusted === undefined) {
    return { ok: false, detail: `signature key_id '${signature.key_id}' is not in the trusted set` };
  }
  const message = new TextEncoder().encode(entry.sha256.toLowerCase());
  const result = await verifyEd25519(message, decodeBase64Lenient(signature.value), trusted.public_key);
  if (result.keyType === null) return { ok: false, detail: `trusted key '${trusted.key_id}' is not parseable as DER SPKI` };
  if (result.keyType !== 'ed25519') return { ok: false, detail: `trusted key '${trusted.key_id}' is not an ed25519 key` };
  if (!result.ok) {
    return { ok: false, detail: `ed25519 signature verification failed for '${signature.key_id}' over the entry digest` };
  }
  return { ok: true };
}

export async function verifyArtifactBytes(
  artifact: Uint8Array,
  entry: FeedVersionEntry,
  trustedKeys: ReadonlyArray<TrustedKey>,
): Promise<VerificationResult> {
  const actual = await sha256Hex(artifact);
  const declared = entry.sha256.toLowerCase();
  if (!SHA256_RE.test(declared) || actual !== declared) {
    return {
      ok: false,
      detail: `sha256 digest mismatch: downloaded artifact digest ${actual} does not match the feed entry digest ${entry.sha256}`,
    };
  }
  return verifyFeedEntrySignature(entry, trustedKeys);
}

// --------------------------------------------------------------------- //
// the gated entry point (same outcome shape and semantics as desktop)
// --------------------------------------------------------------------- //

export async function runUpdateCheck(
  state: UpdatesState,
  installed: ReadonlyArray<{ packId: string; version: string }>,
  deps: UpdateCheckDeps,
  trustedKeys: ReadonlyArray<TrustedKey>,
): Promise<UpdateCheckOutcome> {
  if (!state.optIn) {
    // The gate precedes everything: not even the URL is read.
    return { skipped: true, reason: 'opt-in' };
  }
  const url = state.feedUrl !== undefined && state.feedUrl !== '' ? state.feedUrl : DEFAULT_UPDATE_FEED_URL;
  // Fail closed (PR 144 review F13): the pack-updates record is plain
  // localStorage, so a configured non-https feed URL is refused here before any
  // request, never silently replaced by the default feed.
  if (!isHttpsUrl(url)) {
    return { skipped: false, candidates: [], refused: [], error: 'update feed URL must be https; no request was made' };
  }
  let feedText: string;
  try {
    feedText = await deps.fetchFeed(url);
  } catch (err) {
    return { skipped: false, candidates: [], refused: [], error: `feed fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let feed: PackFeedDocument;
  try {
    const parsed: unknown = JSON.parse(feedText);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'schema_version' in parsed &&
      typeof (parsed as { schema_version: unknown }).schema_version === 'number' &&
      (parsed as { schema_version: number }).schema_version > 1
    ) {
      return {
        skipped: false,
        candidates: [],
        refused: [],
        error: `feed schema version ${(parsed as { schema_version: number }).schema_version} is newer than this app supports (1); update the app to read this feed`,
      };
    }
    const validation = validateFeedDocument(parsed);
    if (!validation.ok) return { skipped: false, candidates: [], refused: [], error: validation.detail };
    feed = parsed as PackFeedDocument;
  } catch (err) {
    return {
      skipped: false,
      candidates: [],
      refused: [],
      error: `feed document is not a valid pack-feed document: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const candidates: PackUpdateCandidate[] = [];
  const refused: Array<{ packId: string; version: string; reason: string }> = [];
  const entries: Record<string, FeedVersionEntry> = {};
  for (const feedPack of mergeFeedPacks(feed)) {
    const currentVersion = currentInstalledVersion(installed, feedPack.pack_id);
    if (currentVersion === null) continue;
    const best = bestVersionEntry(feedPack.versions, currentVersion);
    if (best === null) continue;
    const verdict = await verifyFeedEntrySignature(best, trustedKeys);
    if (!verdict.ok) {
      refused.push({ packId: feedPack.pack_id, version: best.version, reason: verdict.detail ?? 'signature verification failed' });
      continue;
    }
    candidates.push({
      packId: feedPack.pack_id,
      currentVersion,
      availableVersion: best.version,
      publishedAt: best.published_at,
      downloadUrl: best.download_url,
      sha256: best.sha256,
      sizeBytes: best.size_bytes,
    });
    entries[feedPack.pack_id] = best;
  }
  return { skipped: false, candidates, refused, entries };
}

// --------------------------------------------------------------------- //
// production network glue (the ONLY outbound call of the update channel)
// --------------------------------------------------------------------- //

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Bounded https GET: refuses a non-https request URL and a non-https FINAL
 * URL, omits credentials and the referrer, never caches, enforces a timeout,
 * and reads at most `capBytes` (content-length checked first, then per chunk).
 */
async function fetchHttpsCapped(url: string, capBytes: number, timeoutMs: number, accept: string): Promise<Uint8Array> {
  if (IS_AIRGAP) throw new Error('update checks are not available in the air-gapped build');
  if (!isHttpsUrl(url)) throw new Error(`refusing to request a non-https URL: ${url}`);
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    redirect: 'follow',
    mode: 'cors',
    headers: { accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!isHttpsUrl(response.url || url)) {
    void response.body?.cancel();
    throw new Error(`refusing a response served from a non-https URL: ${response.url}`);
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`answered HTTP ${response.status}`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > capBytes) {
    void response.body?.cancel();
    throw new Error(`response body exceeds the ${capBytes}-byte cap (content-length ${declared})`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    if (buffered.byteLength > capBytes) throw new Error(`response body exceeds the ${capBytes}-byte cap`);
    return buffered;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > capBytes) {
      void reader.cancel();
      throw new Error(`response body exceeds the ${capBytes}-byte cap`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Production fetchFeed: https-only, 5 MiB cap, 15 s timeout, no credentials. */
export async function fetchFeedText(url: string): Promise<string> {
  try {
    return new TextDecoder().decode(await fetchHttpsCapped(url, FEED_MAX_BYTES, FEED_TIMEOUT_MS, 'application/json'));
  } catch (err) {
    throw new Error(corsAwareMessage(err));
  }
}

/** Production artifact download: https-only, exact feed-declared size (<= 50 MiB). */
export async function downloadArtifactBytes(url: string, expectedBytes: number): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchHttpsCapped(url, Math.min(expectedBytes, MAX_PACK_ARTIFACT_BYTES), ARTIFACT_TIMEOUT_MS, 'application/zip, application/octet-stream');
  } catch (err) {
    throw new Error(corsAwareMessage(err));
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`artifact size mismatch: received ${bytes.byteLength} bytes, feed declares ${expectedBytes}`);
  }
  return bytes;
}

/** A TypeError from fetch is how browsers report a CORS refusal (or no network). */
function corsAwareMessage(err: unknown): string {
  if (err instanceof TypeError) {
    return `${err.message} (the host may not allow cross-origin requests; browser updates need a CORS-enabled feed or mirror, or use the desktop app)`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface ApplyUpdateResult {
  applied: boolean;
  version?: string;
  reason?: string;
}

/**
 * Download -> sha256 + Ed25519 re-verify against the SIGNED feed entry ->
 * install through the shared install path.
 */
export async function applyPackUpdate(
  candidate: PackUpdateCandidate,
  entry: FeedVersionEntry,
  deps: {
    downloadArtifact: (url: string, expectedBytes: number) => Promise<Uint8Array>;
    installPack: (zipBytes: Uint8Array, filename: string) => Promise<{ version: string }>;
  },
  trustedKeys: ReadonlyArray<TrustedKey>,
): Promise<ApplyUpdateResult> {
  let artifact: Uint8Array;
  try {
    artifact = await deps.downloadArtifact(candidate.downloadUrl, candidate.sizeBytes);
  } catch (err) {
    return { applied: false, reason: `artifact download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const verdict = await verifyArtifactBytes(artifact, entry, trustedKeys);
  if (!verdict.ok) return { applied: false, reason: `update refused: ${verdict.detail ?? 'verification failed'}` };
  try {
    const installed = await deps.installPack(artifact, `${candidate.packId}-${candidate.availableVersion}.zip`);
    return { applied: true, version: installed.version };
  } catch (err) {
    return { applied: false, reason: `install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
