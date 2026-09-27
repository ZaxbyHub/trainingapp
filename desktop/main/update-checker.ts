// update-checker.ts — E5 (issue #88): signed application and knowledge-pack
// update channels with rollback.
//
// Design contract (ADR-0010, docs/updates.md):
//   * Offline-first: update checks are OPT-IN. `loadUpdatesState` defaults to
//     `{ optIn: false }` and `runUpdateCheck` performs ZERO network activity
//     until the user explicitly opts in (frozen check C5).
//   * Feed-level trust boundary: everything served over the update feed is
//     Ed25519-signed over the artifact's sha256 (lowercase 64-hex UTF-8
//     message) and verified against the build-time-baked public key. There is
//     no unsigned fallback; a missing/unknown-key/wrong-algorithm/tampered
//     entry is refused (frozen check C3).
//   * The pack install itself rides the existing hardened C8 pipeline
//     (extractPackZip + PackManager.install) through the loopback API, so
//     supersede/rollback semantics (inactive-but-retained) are unchanged
//     (frozen check C4 exercises them against the real PackManager).
//   * Electron-import-free: this module must stay testable under plain node
//     (the desktop vitest electron stub is never needed here).
//
// The pure-diff / verification / opt-in-state surface below is the frozen
// contract the acceptance checks were authored against BEFORE this file
// existed (desktop/src/__tests__/e5-update-checker.test.ts); do not change
// its shape without a sanctioned checkpoint AMEND.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_('ajv/dist/2020') as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => { compile(schema: object): (data: unknown) => boolean };

// ---------------------------------------------------------------------------
// Frozen contract types
// ---------------------------------------------------------------------------

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
  app?: {
    versions: Array<{
      version: string;
      published_at: string;
      sha256: string;
      size_bytes: number;
      download_url: string;
      notes_url?: string;
      signature?: { algorithm: string; key_id: string; value: string };
    }>;
  };
}

export interface TrustedKey {
  key_id: string;
  public_key: string; // base64 DER SubjectPublicKeyInfo of an ed25519 key
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
      /** Winning feed entry per candidate packId — the signed object the
       * apply path re-verifies (candidates themselves carry no signature). */
      entries?: Record<string, FeedVersionEntry>;
      /** The validated feed document, for consumers that diff more than the
       * pack list (the desktop wiring diffs the app section, ADR-0010). */
      feed?: PackFeedDocument;
    };

// ---------------------------------------------------------------------------
// Baked trust anchor + feed location
// ---------------------------------------------------------------------------

/** Build-time-baked feed signing public key (base64 DER SPKI, ed25519).
 * Ceremony and custody: docs/adr/0010-update-channels.md — the private half
 * lives with the release owner OUTSIDE any repository; rotation ships a new
 * baked key plus a new key_id. */
export const UPDATE_FEED_PUBLIC_KEY: TrustedKey = {
  key_id: 'trainingapp-update-feed-2026-09',
  public_key: 'MCowBQYDK2VwAyEADMDkiyQsDNMPSdRlmNxr+dePysmqGTFGyG6EkF9yvXQ=',
};

/** Default feed location: the signed feed document is published as a GitHub
 * Releases asset ("latest" asset URL pattern). An operator can override it
 * via the `feedUrl` field of the profile's updates.json sidecar. */
export const DEFAULT_UPDATE_FEED_URL =
  'https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json';

// ---------------------------------------------------------------------------
// Semver ordering (mirrors pack-manager.ts versionKey/compareVersionKeys)
// ---------------------------------------------------------------------------

interface VersionKey {
  major: number;
  minor: number;
  patch: number;
  pre: number; // 1 = release, 0 = pre-release: releases sort above their own RCs
}

export function parseVersionKey(version: string): VersionKey | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? 1 : 0,
  };
}

export function compareVersionKeys(a: VersionKey, b: VersionKey): number {
  for (const field of ['major', 'minor', 'patch', 'pre'] as const) {
    if (a[field] !== b[field]) return a[field] - b[field];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Pack update diff (frozen check C2)
// ---------------------------------------------------------------------------

export function checkPackUpdates(
  installed: ReadonlyArray<{ packId: string; version: string }>,
  feed: PackFeedDocument,
): PackUpdateCandidate[] {
  const candidates: PackUpdateCandidate[] = [];
  for (const feedPack of feed.packs) {
    const current = installed.find((record) => record.packId === feedPack.pack_id);
    if (current === undefined) continue;
    const best = bestVersionEntry(feedPack.versions, current.version);
    if (best !== null) {
      candidates.push(toCandidate(feedPack.pack_id, current.version, best));
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Signature verification (frozen check C3) — Ed25519 over the artifact digest
// ---------------------------------------------------------------------------

export interface VerificationResult {
  ok: boolean;
  detail?: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function verifyFeedEntrySignature(
  entry: FeedVersionEntry,
  trustedKeys: ReadonlyArray<TrustedKey>,
): VerificationResult {
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
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature.value, 'base64');
  } catch {
    return { ok: false, detail: 'signature value is not valid base64' };
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(trusted.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, detail: `trusted key '${trusted.key_id}' is not parseable as DER SPKI` };
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return { ok: false, detail: `trusted key '${trusted.key_id}' is not an ed25519 key` };
  }
  // The signed message is the artifact digest exactly as published: the
  // lowercase 64-hex sha256 string as UTF-8 bytes.
  const message = Buffer.from(entry.sha256.toLowerCase(), 'utf8');
  const verified = cryptoVerify(null, message, publicKey, signatureBytes);
  if (!verified) {
    return { ok: false, detail: `ed25519 signature verification failed for '${signature.key_id}' over the entry digest` };
  }
  return { ok: true };
}

export function verifyArtifactBytes(
  artifact: Uint8Array,
  entry: FeedVersionEntry,
  trustedKeys: ReadonlyArray<TrustedKey>,
): VerificationResult {
  const actual = createHash('sha256').update(artifact).digest('hex');
  const declared = entry.sha256.toLowerCase();
  if (!SHA256_HEX_RE.test(declared) || actual !== declared) {
    return {
      ok: false,
      detail: `sha256 digest mismatch: downloaded artifact digest ${actual} does not match the feed entry digest ${entry.sha256}`,
    };
  }
  return verifyFeedEntrySignature(entry, trustedKeys);
}

// ---------------------------------------------------------------------------
// Opt-in state sidecar (frozen check C5) — atomic tmp+rename, fail closed
// ---------------------------------------------------------------------------

const UPDATES_FILE_NAME = 'updates.json';

export function updatesStatePathFor(profileDir: string): string {
  return path.join(profileDir, UPDATES_FILE_NAME);
}

export function loadUpdatesState(profileDir: string): UpdatesState {
  const file = updatesStatePathFor(profileDir);
  if (!existsSync(file)) return { optIn: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { optIn: false };
    }
    const record = parsed as { optIn?: unknown; feedUrl?: unknown };
    if (typeof record.optIn !== 'boolean') return { optIn: false };
    // Exact-shape contract: the feedUrl key exists only when a usable string
    // is stored, so a default state reads back as exactly `{ optIn: false }`.
    if (typeof record.feedUrl === 'string' && record.feedUrl !== '') {
      return { optIn: record.optIn, feedUrl: record.feedUrl };
    }
    return { optIn: record.optIn };
  } catch {
    return { optIn: false };
  }
}

export function saveUpdatesState(profileDir: string, state: UpdatesState): void {
  mkdirSync(profileDir, { recursive: true });
  const file = updatesStatePathFor(profileDir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The gated entry point (frozen check C5)
// ---------------------------------------------------------------------------

export async function runUpdateCheck(
  state: UpdatesState,
  installed: ReadonlyArray<{ packId: string; version: string }>,
  deps: UpdateCheckDeps,
  trustedKeys: ReadonlyArray<TrustedKey>,
): Promise<UpdateCheckOutcome> {
  if (!state.optIn) {
    // The gate precedes everything: not even the URL is read, no fetch call
    // is made, nothing leaves the machine.
    return { skipped: true, reason: 'opt-in' };
  }
  const url = state.feedUrl !== undefined && state.feedUrl !== '' ? state.feedUrl : DEFAULT_UPDATE_FEED_URL;
  let feedText: string;
  try {
    feedText = await deps.fetchFeed(url);
  } catch (err) {
    return {
      skipped: false,
      candidates: [],
      refused: [],
      error: `feed fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let feed: PackFeedDocument;
  try {
    const parsed: unknown = JSON.parse(feedText);
    const validation = validateFeedDocument(parsed);
    if (!validation.ok) {
      return { skipped: false, candidates: [], refused: [], error: validation.detail };
    }
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
  for (const feedPack of feed.packs) {
    const current = installed.find((record) => record.packId === feedPack.pack_id);
    if (current === undefined) continue;
    const best = bestVersionEntry(feedPack.versions, current.version);
    if (best === null) continue;
    const verdict = verifyFeedEntrySignature(best, trustedKeys);
    if (!verdict.ok) {
      refused.push({ packId: feedPack.pack_id, version: best.version, reason: verdict.detail ?? 'signature verification failed' });
      continue;
    }
    candidates.push(toCandidate(feedPack.pack_id, current.version, best));
    entries[feedPack.pack_id] = best;
  }
  return { skipped: false, candidates, refused, entries, feed };
}

/** The newest feed version that compares GREATER than `currentVersion` under
 * the pack semver ordering — the single selection rule shared by
 * `checkPackUpdates` (frozen C2) and `runUpdateCheck` so the production diff
 * and the tested diff cannot drift apart (review round 1, finding 3). */
function bestVersionEntry(
  versions: ReadonlyArray<FeedVersionEntry>,
  currentVersion: string,
): FeedVersionEntry | null {
  const currentKey = parseVersionKey(currentVersion);
  if (currentKey === null) return null;
  let best: FeedVersionEntry | null = null;
  let bestKey: ReturnType<typeof parseVersionKey> = null;
  for (const entry of versions) {
    const entryKey = parseVersionKey(entry.version);
    if (entryKey === null) continue;
    if (compareVersionKeys(entryKey, currentKey) <= 0) continue;
    if (bestKey === null || compareVersionKeys(entryKey, bestKey) > 0) {
      best = entry;
      bestKey = entryKey;
    }
  }
  return best;
}

function toCandidate(packId: string, currentVersion: string, best: FeedVersionEntry): PackUpdateCandidate {
  return {
    packId,
    currentVersion,
    availableVersion: best.version,
    publishedAt: best.published_at,
    downloadUrl: best.download_url,
    sha256: best.sha256,
    sizeBytes: best.size_bytes,
  };
}

// ---------------------------------------------------------------------------
// App-binary update diff (detect + notify only; ADR-0010's manual channel)
// ---------------------------------------------------------------------------

export interface AppUpdateCandidate {
  currentVersion: string;
  availableVersion: string;
  publishedAt: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  notesUrl?: string;
}

/** App-update notice derivation, MANDATORY-VERIFY (review round 1, finding 1):
 * the newest app version is selected with the same ordering rule as packs and
 * is returned ONLY when its Ed25519 signature verifies against the trusted
 * keys — an unsigned/untrusted app entry yields null, so an unverifiable
 * download link is never surfaced in Settings. */
export function checkAppUpdateVerified(
  feed: PackFeedDocument,
  currentAppVersion: string,
  trustedKeys: ReadonlyArray<TrustedKey>,
): AppUpdateCandidate | null {
  const versions = feed.app?.versions;
  if (!Array.isArray(versions)) return null;
  const best = bestVersionEntry(versions as FeedVersionEntry[], currentAppVersion);
  if (best === null) return null;
  const verdict = verifyFeedEntrySignature(best, trustedKeys);
  if (!verdict.ok) return null;
  return {
    currentVersion: currentAppVersion,
    availableVersion: best.version,
    publishedAt: best.published_at,
    downloadUrl: best.download_url,
    sha256: best.sha256,
    sizeBytes: best.size_bytes,
    ...((best as { notes_url?: string }).notes_url !== undefined
      ? { notesUrl: (best as { notes_url?: string }).notes_url }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Production glue: hardened fetch, feed validation, apply composition
// ---------------------------------------------------------------------------

const FEED_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB cap on the feed document (plan D8)
const FEED_TIMEOUT_MS = 15_000;

function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Streaming bounded body read (review round 1, finding 2): rejects on the
 * declared content-length BEFORE reading, then accumulates chunks until the
 * cap is exceeded — the connection is cancelled, never buffered past the
 * cap. `capBytes` is an upper bound for the feed (5 MiB) and an exact-size
 * gate for artifacts (callers compare the result length separately). */
async function readBodyCapped(response: Response, capBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > capBytes) {
    throw new Error(`response body exceeds the ${capBytes}-byte cap (content-length ${declaredLength})`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    if (buffered.byteLength > capBytes) {
      throw new Error(`response body exceeds the ${capBytes}-byte cap`);
    }
    return buffered;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
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

/** Hardened production fetchFeed (plan D8): https-only, credentials omitted,
 * explicit timeout, response capped at 5 MiB, final URL re-validated as
 * https after redirects. No identifying payload: a bare GET for the feed. */
export async function fetchFeedText(url: string): Promise<string> {
  if (!isHttpsUrl(url)) {
    throw new Error(`refusing to fetch a non-https feed URL: ${url}`);
  }
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`feed fetch answered HTTP ${response.status}`);
  }
  if (!isHttpsUrl(response.url)) {
    throw new Error('feed fetch redirected away from https');
  }
  const bytes = await readBodyCapped(response, FEED_MAX_BYTES);
  return Buffer.from(bytes).toString('utf8');
}

const FEED_SCHEMA_RELATIVE_PATH = 'contracts/pack-feed.schema.json';

function repoRootFrom(moduleDir: string): string {
  let current = moduleDir;
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (contracts marker not found)');
}

let feedValidator: ((data: unknown) => boolean) | null = null;

/** Validate a parsed feed document against the shipped JSON Schema
 * (contracts/pack-feed.schema.json) — the schema file is the single source
 * of truth, compiled with the same options pack-manager uses. */
export function validateFeedDocument(parsed: unknown): { ok: boolean; detail?: string } {
  if (feedValidator === null) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.join(repoRootFrom(moduleDir), FEED_SCHEMA_RELATIVE_PATH);
    const schemaJson: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    feedValidator = ajv.compile(schemaJson as object);
  }
  if (!feedValidator(parsed)) {
    return { ok: false, detail: 'feed document does not satisfy contracts/pack-feed.schema.json' };
  }
  return { ok: true };
}

export interface ApplyUpdateDeps {
  downloadArtifact: (url: string, expectedBytes: number) => Promise<Uint8Array>;
  installPack: (zipBytes: Uint8Array, filename: string) => Promise<{ version: string }>;
}

export interface ApplyUpdateResult {
  applied: boolean;
  version?: string;
  reason?: string;
}

const ARTIFACT_TIMEOUT_MS = 120_000;

/** Hardened production artifact download (plan D8): https-only, credentials
 * omitted, explicit timeout, and the response is refused when its byte
 * length differs from the feed-declared size (the sha256 gate stays the
 * final arbiter either way). */
export async function downloadArtifactBytes(url: string, expectedBytes: number): Promise<Uint8Array> {
  if (!isHttpsUrl(url)) {
    throw new Error(`refusing to download a non-https artifact URL: ${url}`);
  }
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`artifact download answered HTTP ${response.status}`);
  }
  if (!isHttpsUrl(response.url)) {
    throw new Error('artifact download redirected away from https');
  }
  const bytes = await readBodyCapped(response, expectedBytes);
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`artifact size mismatch: received ${bytes.byteLength} bytes, feed declares ${expectedBytes}`);
  }
  return bytes;
}

/** Production install leg: POST the verified zip to the app's own loopback
 * pack-install route, so the C8 guards and supersede semantics apply
 * unchanged. Needs the loopback base URL and the per-launch token. */
export function loopbackPackInstaller(
  baseUrl: string,
  token: string,
  tokenHeaderName: string,
): (zipBytes: Uint8Array, filename: string) => Promise<{ version: string }> {
  return async (zipBytes: Uint8Array, filename: string) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }), filename);
    const response = await fetch(`${baseUrl}/packs/install`, {
      method: 'POST',
      credentials: 'omit',
      headers: { [tokenHeaderName]: token },
      body: form,
      signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`pack install answered HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as { version?: string };
    return { version: body.version ?? '' };
  };
}

/** Download-verify-install composition (plan R3 coverage note): the verified
 * pieces are individually tested — `verifyArtifactBytes` (frozen C3),
 * `extractPackZip` + `PackManager.install` (C8 suite; production wiring
 * posts the zip to the loopback `POST /packs/install` with the launch token
 * so the C8 guards and supersede semantics apply unchanged). The signed
 * `entry` (not the camelCase candidate) is what gets re-verified. */
export async function applyPackUpdate(
  candidate: PackUpdateCandidate,
  entry: FeedVersionEntry,
  deps: ApplyUpdateDeps,
  trustedKeys: ReadonlyArray<TrustedKey>,
): Promise<ApplyUpdateResult> {
  let artifact: Uint8Array;
  try {
    artifact = await deps.downloadArtifact(candidate.downloadUrl, candidate.sizeBytes);
  } catch (err) {
    return { applied: false, reason: `artifact download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const verdict = verifyArtifactBytes(artifact, entry, trustedKeys);
  if (!verdict.ok) {
    return { applied: false, reason: `update refused: ${verdict.detail ?? 'verification failed'}` };
  }
  try {
    const installed = await deps.installPack(artifact, `${candidate.packId}-${candidate.availableVersion}.zip`);
    return { applied: true, version: installed.version };
  } catch (err) {
    return { applied: false, reason: `install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
