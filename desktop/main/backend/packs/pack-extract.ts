// packs/pack-extract.ts — the extraction-safety + pack-security core
// (issue #75, C8).
//
// One module owns every hardening invariant for the Node backend's pack
// installation seam, so the zip-upload extractor (surface.ts -> extractPackZip)
// and PackManager's install-time gates share a single implementation instead
// of drifting:
//
//   S1  config-driven limits (TRAININGAPP_PACKS_* env, BackendHostConfig
//       .packsSecurity overrides) with the issue's defaults: 2 GiB total
//       uncompressed, 5000 entries, 100:1 compression ratio,
//   S2  safeEntryName/ensureContained — every archive entry is validated by
//       RESOLVED-PATH containment, not token shape (fixes the drive-relative
//       'E:../x' escape class: a segment like 'E:..' is not '..' but
//       path.win32.join treats it as a new anchor, discarding the root),
//   S3  declared-size / declared-ratio / entry-count pre-filter via a minimal
//       ZIP32 central-directory parser that runs BEFORE JSZip ever
//       decompresses (bit-3 data descriptors corrupt LOCAL headers only; the
//       central directory stays authoritative),
//   S4  symlink entries refused (raw unix mode AND the JSZip-parsed view),
//   S5  the post-hoc written-bytes cap kept as the unspoofable backstop
//       (declared metadata is spoofable; bytes actually written are not),
//   S6  the manifest embedding-model pin, index stamps, and the opt-in
//       ed25519 detached-signature gate (consumed by PackManager).
//
// Python twin: pack_extract.py (api_server + pack_manager); packtool twin:
// packtool/build/pack-json.ts. Desktop and packtool are separate npm packages
// with no workspace root, so the sharing is behavioral parity pinned by the
// frozen checks + the cross-backend suites (disclosed in the #75 PR body).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import JSZip from 'jszip';
import { PackManagerError } from '../store/pack-manager.js';

// --------------------------------------------------------------------- //
// S1 — limits + config surface
// --------------------------------------------------------------------- //

/** Default total-uncompressed cap per archive (2 GiB, the issue's default). */
export const DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES = 2147483648;
/** Default entry-count cap per archive (the issue's default). */
export const DEFAULT_PACKS_MAX_ENTRIES = 5000;
/** Default aggregate declared compression-ratio cap (100:1, new in #75). */
export const DEFAULT_PACKS_MAX_COMPRESSION_RATIO = 100;
/**
 * The embedding-model pin gate target (ADR-0006). Packtool stamps basenames;
 * the Python settings default 'BAAI/bge-small-en-v1.5' canonicalizes to this
 * same basename. NOT embedder-derived: the gate target is config, not
 * whichever embedder instance happens to be attached.
 */
export const DEFAULT_PACK_EMBEDDING_MODEL_ID = 'bge-small-en-v1.5';

export const PACKS_MAX_UNCOMPRESSED_BYTES_ENV = 'TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES';
export const PACKS_MAX_ENTRIES_ENV = 'TRAININGAPP_PACKS_MAX_ENTRIES';
export const PACKS_MAX_COMPRESSION_RATIO_ENV = 'TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO';
export const PACKS_REQUIRE_SIGNATURE_ENV = 'TRAININGAPP_PACKS_REQUIRE_SIGNATURE';
export const PACKS_TRUSTED_KEYS_ENV = 'TRAININGAPP_PACKS_TRUSTED_KEYS';
export const PACKS_EMBEDDING_MODEL_ID_ENV = 'TRAININGAPP_PACKS_EMBEDDING_MODEL_ID';

/** Extraction limits (the S3/S5 knobs). */
export interface PackSecurityLimits {
  maxUncompressedBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
}

/** One trusted signing key: key_id selects it, public_key is base64 DER SPKI. */
export interface TrustedPackKey {
  key_id: string;
  /** base64-encoded DER SubjectPublicKeyInfo (ed25519). */
  public_key: string;
}

/** Config-shaped overrides (BackendHostConfig.packsSecurity / PackManager option). */
export interface PacksSecurityOverrides {
  embeddingModelId?: string;
  maxUncompressedBytes?: number;
  maxEntries?: number;
  maxCompressionRatio?: number;
  requireSignature?: boolean;
  trustedKeys?: TrustedPackKey[];
}

/** Fully-resolved packs security config (every field concrete). */
export interface ResolvedPacksSecurity extends PackSecurityLimits {
  embeddingModelId: string;
  requireSignature: boolean;
  trustedKeys: TrustedPackKey[];
}

function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[pack-extract] ignoring invalid ${key}=${raw}; using the default ${fallback}`);
    return fallback;
  }
  return value;
}

function envFloat(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[pack-extract] ignoring invalid ${key}=${raw}; using the default ${fallback}`);
    return fallback;
  }
  return value;
}

function envBool(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function envTrustedKeys(env: Record<string, string | undefined>): TrustedPackKey[] {
  const raw = env[PACKS_TRUSTED_KEYS_ENV];
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    return parsed
      .filter(
        (entry): entry is { key_id: string; public_key: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)['key_id'] === 'string' &&
          typeof (entry as Record<string, unknown>)['public_key'] === 'string',
      )
      .map((entry) => ({ key_id: entry.key_id, public_key: entry.public_key }));
  } catch (error) {
    // Fail-closed: malformed keyset trusts NOTHING (with requireSignature on,
    // every pack is refused); visibility via stderr, never a host crash.
    console.error(
      `[pack-extract] ignoring invalid ${PACKS_TRUSTED_KEYS_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * Resolve the packs-security config: explicit overrides beat the
 * TRAININGAPP_PACKS_* env seam beat the defaults.
 */
export function resolvePacksSecurity(
  env: Record<string, string | undefined>,
  overrides?: PacksSecurityOverrides,
): ResolvedPacksSecurity {
  return {
    maxUncompressedBytes: overrides?.maxUncompressedBytes ?? envInt(env, PACKS_MAX_UNCOMPRESSED_BYTES_ENV, DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES),
    maxEntries: overrides?.maxEntries ?? envInt(env, PACKS_MAX_ENTRIES_ENV, DEFAULT_PACKS_MAX_ENTRIES),
    maxCompressionRatio:
      overrides?.maxCompressionRatio ??
      envFloat(env, PACKS_MAX_COMPRESSION_RATIO_ENV, DEFAULT_PACKS_MAX_COMPRESSION_RATIO),
    requireSignature: overrides?.requireSignature ?? envBool(env, PACKS_REQUIRE_SIGNATURE_ENV),
    trustedKeys: overrides?.trustedKeys ?? envTrustedKeys(env),
    embeddingModelId:
      overrides?.embeddingModelId ??
      (env[PACKS_EMBEDDING_MODEL_ID_ENV]?.trim() || undefined) ??
      DEFAULT_PACK_EMBEDDING_MODEL_ID,
  };
}

/** Limits for one extraction call (undefined fields fall back to env+defaults). */
export function resolvePackLimits(
  env: Record<string, string | undefined>,
  limits?: Partial<PackSecurityLimits>,
): PackSecurityLimits {
  const resolved = resolvePacksSecurity(env);
  return {
    maxUncompressedBytes: limits?.maxUncompressedBytes ?? resolved.maxUncompressedBytes,
    maxEntries: limits?.maxEntries ?? resolved.maxEntries,
    maxCompressionRatio: limits?.maxCompressionRatio ?? resolved.maxCompressionRatio,
  };
}

// --------------------------------------------------------------------- //
// S2 — entry-name + containment guards
// --------------------------------------------------------------------- //

/**
 * Refuse entry names that are empty, contain backslashes, are root-relative
 * ('/x') or drive-relative/absolute ('E:../x', 'C:/x' — the C1 escape class),
 * carry '..'/'.' segments, or embed NUL/control characters.
 * Throws PackManagerError with the frozen 'unsafe archive entry path' wording.
 */
export function safeEntryName(name: string): string {
  if (name.length === 0) {
    throw new PackManagerError('unsafe archive entry path: empty name');
  }
  if (name.includes('\\')) {
    throw new PackManagerError(`unsafe archive entry path (backslash): ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/')) {
    throw new PackManagerError(`unsafe archive entry path (absolute): ${JSON.stringify(name)}`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new PackManagerError(
      `unsafe archive entry path (drive-relative/absolute): ${JSON.stringify(name)}`,
    );
  }
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new PackManagerError(
        `unsafe archive entry path (dot segment): ${JSON.stringify(name)}`,
      );
    }
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code === 0 || code < 32 || code === 127) {
      throw new PackManagerError(
        `unsafe archive entry path (control character): ${JSON.stringify(name)}`,
      );
    }
  }
  return name;
}

/**
 * True when `target` resolves strictly INSIDE `root` (not the root itself).
 * path.relative normalizes both sides first, so a trailing separator on
 * either path cannot forge containment (the classic startswith bug); an
 * absolute or '..'-escaping relative result is a refusal.
 */
export function ensureContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isZipFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.zip');
}

export function isSymlinkEntry(unixPermissions: number | string | undefined): boolean {
  // Unix-style archives carry the file mode: S_IFLNK = 0o120000 marks a
  // symlink. DOS-style archives have no symlink representation (directory
  // entries carry the dosPermissions dir bit and are skipped via entry.dir
  // before this check matters).
  const perms =
    typeof unixPermissions === 'string' ? parseInt(unixPermissions, 8) : unixPermissions;
  return typeof perms === 'number' && perms !== 0 && (perms & 0o170000) === 0o120000;
}

// --------------------------------------------------------------------- //
// S3 — ZIP32 central-directory parser (declared-metadata pre-filter)
// --------------------------------------------------------------------- //

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP32_UINT16_MAX = 0xffff;
const ZIP32_UINT32_MAX = 0xffffffff;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
/** Longest possible zip comment; bounds the backward EOCD scan. */
const MAX_ZIP_COMMENT = 0xffff;

/** One central-directory record, as declared by the archive. */
export interface CentralDirectoryEntry {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

/**
 * Locate the ZIP32 end-of-central-directory record by BACKWARD signature
 * scan, honoring the trailing comment length (the record must sit exactly
 * `22 + commentLength` bytes from the end). Scanning from the end instead of
 * trusting a fixed offset tolerates prepended bytes (self-extracting
 * prefixes) — the caller anchors the central directory off the FOUND record.
 * Returns the record's byte offset, or -1 when no valid record exists.
 */
function findEocdOffset(buf: Buffer): number {
  if (buf.length < EOCD_SIZE) return -1;
  const highest = buf.length - EOCD_SIZE;
  const floor = Math.max(0, buf.length - EOCD_SIZE - MAX_ZIP_COMMENT);
  for (let pos = highest; pos >= floor; pos -= 1) {
    if (buf.readUInt32LE(pos) !== EOCD_SIGNATURE) continue;
    if (buf.readUInt16LE(pos + 20) === buf.length - pos - EOCD_SIZE) return pos;
  }
  return -1;
}

/**
 * Walk the ZIP32 central directory of `buf` and return every declared entry
 * (names, sizes, modes). Central-directory declared sizes are authoritative
 * even for bit-3 data-descriptor entries (descriptors zero the LOCAL header
 * fields only, so parsing the central directory has no 0/0 blind spot).
 *
 * ZIP32-only v1: a ZIP64 marker (0xffffffff fields in the EOCD, a ZIP64 EOCD
 * locator, or 0xffffffff sizes in a central header) is REFUSED, not misparsed
 * — unreachable for legitimate packs under the 2 GiB default cap.
 */
export function parseZip32CentralDirectory(buf: Buffer, filename: string): CentralDirectoryEntry[] {
  const eocd = findEocdOffset(buf);
  if (eocd < 0) {
    throw new PackManagerError(`${filename}: not a readable zip archive (no end-of-central-directory record)`);
  }
  const zip64Refusal = `${filename}: ZIP64 markers are refused; pack archives above 4 GiB / 65535 entries are not accepted`;
  if (
    buf.readUInt16LE(eocd + 8) === ZIP32_UINT16_MAX ||
    buf.readUInt16LE(eocd + 10) === ZIP32_UINT16_MAX ||
    buf.readUInt32LE(eocd + 12) === ZIP32_UINT32_MAX ||
    buf.readUInt32LE(eocd + 16) === ZIP32_UINT32_MAX
  ) {
    throw new PackManagerError(zip64Refusal);
  }
  // A ZIP64 EOCD locator sits immediately before the (32-bit) EOCD.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw new PackManagerError(zip64Refusal);
  }
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  // Anchor on the found record, not the declared offset: with prepended
  // bytes the declared cdOffset is shifted by exactly the prefix length.
  const centralStart = eocd - centralSize;
  if (centralStart < 0 || centralSize > eocd) {
    throw new PackManagerError(`${filename}: malformed zip central directory (declared size overruns the archive)`);
  }
  const entries: CentralDirectoryEntry[] = [];
  const seenNames = new Set<string>();
  let pos = centralStart;
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + CENTRAL_HEADER_SIZE > eocd) {
      throw new PackManagerError(`${filename}: malformed zip central directory (truncated header)`);
    }
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new PackManagerError(`${filename}: malformed zip central directory (bad header signature)`);
    }
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const compressedSize = buf.readUInt32LE(pos + 20);
    if (uncompressedSize === ZIP32_UINT32_MAX || compressedSize === ZIP32_UINT32_MAX) {
      throw new PackManagerError(zip64Refusal);
    }
    const nameStart = pos + CENTRAL_HEADER_SIZE;
    if (nameStart + nameLength > eocd) {
      throw new PackManagerError(`${filename}: malformed zip central directory (truncated name)`);
    }
    const name = buf.subarray(nameStart, nameStart + nameLength).toString('utf8');
    // Duplicate entry names are refused: extraction is last-write-wins (and
    // JSZip collapses duplicates at load), so a benign first entry must not
    // mask a hostile duplicate (PRR-004).
    if (seenNames.has(name)) {
      throw new PackManagerError(
        `${filename}: duplicate archive entry ${name} is not allowed`,
      );
    }
    seenNames.add(name);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const mode = externalAttrs >>> 16;
    entries.push({
      name,
      uncompressedSize,
      compressedSize,
      isDirectory: name.endsWith('/') || (mode !== 0 && (mode & 0o170000) === 0o040000),
      isSymlink: mode !== 0 && (mode & 0o170000) === 0o120000,
    });
    pos += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Declared-metadata pre-filter (G4/G5, plan S3): entry count, total declared
 * uncompressed size, and aggregate declared compression ratio over the raw
 * central directory — all BEFORE any decompression work.
 */
export function enforceDeclaredLimits(
  entries: CentralDirectoryEntry[],
  limits: PackSecurityLimits,
  filename: string,
): void {
  if (entries.length > limits.maxEntries) {
    throw new PackManagerError(
      `${filename}: archive declares ${entries.length} entries, over the ${limits.maxEntries} entry cap`,
    );
  }
  let totalUncompressed = 0;
  let ratioUncompressed = 0;
  let ratioCompressed = 0;
  for (const entry of entries) {
    if (entry.isDirectory || entry.uncompressedSize === 0) continue;
    totalUncompressed += entry.uncompressedSize;
    ratioUncompressed += entry.uncompressedSize;
    ratioCompressed += entry.compressedSize;
  }
  if (totalUncompressed > limits.maxUncompressedBytes) {
    throw new PackManagerError(
      `${filename}: archive declares ${totalUncompressed} uncompressed bytes, over the ${limits.maxUncompressedBytes} byte cap`,
    );
  }
  // Skip dir/zero entries (plan G5): only real payloads count toward the
  // ratio. A declared payload with zero compressed bytes is not compressible
  // input — it is a malformed or crafted record; fail closed.
  // Ratio is enforced only above an absolute floor: the byte cap bounds
  // small archives absolutely, and legitimate sqlite vector pages compress
  // far beyond 100:1 on tiny indexes.
  const RATIO_FLOOR_BYTES = 16 * 1024 * 1024;
  const ratioEnforced = ratioUncompressed >= RATIO_FLOOR_BYTES;
  if (ratioEnforced && (ratioCompressed === 0 || ratioUncompressed / ratioCompressed > limits.maxCompressionRatio)) {
    const ratio = ratioCompressed === 0 ? Number.POSITIVE_INFINITY : ratioUncompressed / ratioCompressed;
    throw new PackManagerError(
      `${filename}: archive declares a ${ratio.toFixed(1)}:1 compression ratio, over the ${limits.maxCompressionRatio}:1 cap (possible zip bomb)`,
    );
  }
}

// --------------------------------------------------------------------- //
// S6 — embedding-model pin + detached-signature gates (PackManager's twin of
// packtool/build/pack-json.ts; parity pinned by the frozen checks)
// --------------------------------------------------------------------- //

/** Canonical embedding-model comparison: strip through the last '/', casefold. */
export function modelIdMatches(declared: string, expected: string): boolean {
  const canonical = (value: string): string => {
    const slash = value.lastIndexOf('/');
    return (slash >= 0 ? value.slice(slash + 1) : value).trim().toLowerCase();
  };
  return canonical(declared) === canonical(expected);
}

/**
 * Recursively sort object keys (arrays keep order); FAIL-CLOSED on
 * non-integer numbers — the pack schema only permits integer numerics, and a
 * float is the one place Node/Python serialization could diverge, so a float
 * makes the signature unverifiable instead of mismatched.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new PackManagerError(
      `manifest carries the non-integer number ${String(value)}; signature canonicalization is fail-closed`,
    );
  }
  return value;
}

/**
 * The detached-signature payload: the manifest with its signature block
 * removed, keys recursively sorted, compact separators (',', ':'), raw UTF-8 —
 * byte-identical to the Python twin's
 * `json.dumps(bare, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 */
export function canonicalManifestBytes(manifestBytes: Uint8Array): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch (error) {
    throw new PackManagerError(
      `signature canonicalization failed: manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackManagerError('signature canonicalization failed: manifest is not a JSON object');
  }
  const bare = { ...(parsed as Record<string, unknown>) };
  delete bare['signature'];
  return Buffer.from(JSON.stringify(sortKeysDeep(bare)), 'utf8');
}

export interface SignatureVerification {
  ok: boolean;
  detail?: string;
}

/**
 * Verify a manifest's detached ed25519 signature: algorithm 'ed25519', value
 * base64 over canonicalManifestBytes of the RAW manifest bytes, key_id
 * selecting a trusted key (base64 DER SPKI). FAIL-CLOSED on every malformed
 * input — a refusal, never an exception leak.
 */
export function verifyPackSignature(
  manifestBytes: Uint8Array,
  signature: unknown,
  trustedKeys: readonly TrustedPackKey[],
): SignatureVerification {
  if (typeof signature !== 'object' || signature === null) {
    return { ok: false, detail: 'signature block is missing' };
  }
  const block = signature as Record<string, unknown>;
  if (block['algorithm'] !== 'ed25519') {
    return { ok: false, detail: `signature algorithm ${JSON.stringify(block['algorithm'])} is not supported (want 'ed25519')` };
  }
  const keyId = block['key_id'];
  if (typeof keyId !== 'string' || keyId.length === 0) {
    return { ok: false, detail: 'signature key_id is missing' };
  }
  const trusted = trustedKeys.find((key) => key.key_id === keyId);
  if (trusted === undefined) {
    return { ok: false, detail: `signature key_id '${keyId}' is not in the trusted keyset` };
  }
  const value = block['value'];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, detail: 'signature value is missing' };
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(value, 'base64');
  } catch {
    return { ok: false, detail: 'signature value is not valid base64' };
  }
  let canonical: Buffer;
  try {
    canonical = canonicalManifestBytes(manifestBytes);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(trusted.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    // Key-type gate (PRR-022, Python-parity): without this, an RSA SPKI in
    // trustedKeys plus an RSA signature VERIFIES (Node's null-digest
    // RSA round-trip), silently widening the documented ed25519-only scheme.
    if (key.asymmetricKeyType !== 'ed25519') {
      return {
        ok: false,
        detail: `trusted key ${trusted.key_id} is not an ed25519 public key (${String(key.asymmetricKeyType)})`,
      };
    }
    return { ok: cryptoVerify(null, canonical, key, sig) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// --------------------------------------------------------------------- //
// the hardened extractor
// --------------------------------------------------------------------- //

/**
 * Extract a pack zip into a fresh temp directory and return its path. The
 * caller owns cleanup (`fs.rmSync(dir, { recursive: true, force: true })`).
 * Refusals throw PackManagerError with an actionable message.
 *
 * Limits are optional: the two-argument form resolves them from the
 * TRAININGAPP_PACKS_* env seam (config overrides flow through the host).
 */
export async function extractPackZip(
  zip: Uint8Array,
  filename: string,
  limits?: Partial<PackSecurityLimits>,
): Promise<string> {
  if (!isZipFilename(filename)) {
    throw new PackManagerError(`${filename}: pack install accepts .zip archives only`);
  }
  const resolvedLimits = resolvePackLimits(process.env, limits);

  // S3 first: the declared-metadata pre-filter over the raw central
  // directory — entry count, declared sizes, declared ratio — plus S2 name
  // validation and S4 symlink refusal on the AUTHORITATIVE raw names (JSZip
  // normalizes hostile names like '../x' away on load; the raw bytes never
  // lie). All of this runs before any decompression.
  const raw = Buffer.from(zip);
  const declared = parseZip32CentralDirectory(raw, filename);
  enforceDeclaredLimits(declared, resolvedLimits, filename);
  for (const entry of declared) {
    safeEntryName(entry.name);
    if (entry.isSymlink) {
      throw new PackManagerError(`${filename}: symlink archive entry ${entry.name} is not allowed`);
    }
  }

  let loaded: JSZip;
  try {
    loaded = await JSZip.loadAsync(zip);
  } catch (error) {
    throw new PackManagerError(
      `${filename}: not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = Object.values(loaded.files);
  if (entries.length > resolvedLimits.maxEntries) {
    throw new PackManagerError(
      `${filename}: archive has ${entries.length} entries, over the ${resolvedLimits.maxEntries} entry cap`,
    );
  }

  // Safest-first ordering (mirrors api_server.py _extract_pack_zip): validate
  // every entry path (S2/S4 on the decompressor's own view) before the
  // manifest-presence check, so a hostile archive is refused on its path
  // shape regardless of what it packs.
  for (const entry of entries) {
    try {
      safeEntryName(entry.name);
    } catch (error) {
      throw new PackManagerError(
        `${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // G3: unix symlink modes are refused outright.
    const { unixPermissions } = entry as {
      unixPermissions?: number | string;
    };
    if (isSymlinkEntry(unixPermissions)) {
      throw new PackManagerError(`${filename}: symlink archive entry ${entry.name} is not allowed`);
    }
  }

  // G1: the C1 manifest-presence check; the manager's schema validation runs
  // next on the extracted folder.
  const manifest = entries.find(
    (entry) => !entry.dir && (entry.name === 'pack.json' || entry.name === './pack.json'),
  );
  if (manifest === undefined) {
    throw new PackManagerError(`${filename}: no pack.json manifest at the archive root`);
  }

  let totalUncompressed = 0;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-install-'));
  try {
    for (const entry of entries) {
      if (entry.dir) continue;
      // Resolved-path containment BEFORE any bytes are written (S2): the name
      // survived safeEntryName twice, but the write target is checked against
      // the extraction root, not the name's shape.
      const target = path.join(outDir, ...entry.name.split('/'));
      if (!ensureContained(outDir, target)) {
        throw new PackManagerError(
          `${filename}: unsafe archive entry path ${JSON.stringify(entry.name)} escapes the extraction root`,
        );
      }
      const data = await entry.async('nodebuffer');
      // S5: the unspoofable backstop — declared metadata lies, written bytes
      // do not. (Residual: JSZip allocates one full entry during
      // decompression; documented in docs/security/packs.md.)
      totalUncompressed += data.length;
      if (totalUncompressed > resolvedLimits.maxUncompressedBytes) {
        throw new PackManagerError(
          `${filename}: archive expands beyond the ${resolvedLimits.maxUncompressedBytes} byte cap`,
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    if (error instanceof PackManagerError) throw error;
    throw new PackManagerError(
      `${filename}: extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return outDir;
}
