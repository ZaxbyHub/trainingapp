// pack-archive-rules.ts — the ONE set of knowledge-pack archive rules shared
// by the desktop extractor (desktop/main/backend/packs/pack-extract.ts) and
// the browser extractor (web_ui/src/lib/packs/pack-extract-browser.ts),
// issue-tracer trace browser-training-parity (AC1).
//
// TWIN FILE: desktop/main/backend/packs/pack-archive-rules.ts and
// web_ui/src/lib/packs/pack-archive-rules.ts are BYTE-IDENTICAL. desktop and
// web_ui are separate npm packages with no workspace root (the desktop
// compile keeps rootDir inside desktop/), so the module is twinned rather
// than imported across packages; desktop/src/__tests__/pack-archive-rules-drift.test.ts
// fails CI on any byte difference. Edit both files together.
//
// Pure and dependency-free (no node:, no DOM): every refusal is built by the
// caller-supplied `fail` factory so each runtime throws its own
// PackManagerError class with the SAME message text.

/** Default total-uncompressed cap per archive (2 GiB). */
export const DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES = 2147483648;
/** Default entry-count cap per archive. */
export const DEFAULT_PACKS_MAX_ENTRIES = 5000;
/** Default aggregate declared compression-ratio cap (100:1). */
export const DEFAULT_PACKS_MAX_COMPRESSION_RATIO = 100;
/**
 * The declared ratio is enforced only above this absolute uncompressed floor:
 * the byte cap bounds small archives absolutely, and legitimate sqlite
 * vector pages compress far beyond 100:1 on tiny indexes.
 */
export const RATIO_FLOOR_BYTES = 16 * 1024 * 1024;

/** Extraction limits (declared pre-filter + written-bytes backstop knobs). */
export interface PackSecurityLimits {
  maxUncompressedBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
}

export type FailFactory = (message: string) => Error;

/** True when the archive's file name carries the .zip extension. */
export function isZipFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.zip');
}

export function notZipMessage(filename: string): string {
  return `${filename}: pack install accepts .zip archives only`;
}

/**
 * Validate one raw archive entry name: refuse empty names, backslashes,
 * root-relative ('/x') and drive-relative/absolute ('E:../x', 'C:/x') names,
 * '.'/'..' segments, and NUL/control characters. Throws via `fail` with the
 * frozen 'unsafe archive entry path' wording; returns the name unchanged.
 */
export function checkEntryName(name: string, fail: FailFactory): string {
  if (name.length === 0) {
    throw fail('unsafe archive entry path: empty name');
  }
  if (name.includes('\\')) {
    throw fail(`unsafe archive entry path (backslash): ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/')) {
    throw fail(`unsafe archive entry path (absolute): ${JSON.stringify(name)}`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw fail(`unsafe archive entry path (drive-relative/absolute): ${JSON.stringify(name)}`);
  }
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.') {
      throw fail(`unsafe archive entry path (dot segment): ${JSON.stringify(name)}`);
    }
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code === 0 || code < 32 || code === 127) {
      throw fail(`unsafe archive entry path (control character): ${JSON.stringify(name)}`);
    }
  }
  return name;
}

export function symlinkEntryMessage(filename: string, entryName: string): string {
  return `${filename}: symlink archive entry ${entryName} is not allowed`;
}

export function missingManifestMessage(filename: string): string {
  return `${filename}: no pack.json manifest at the archive root`;
}

export function expandsBeyondCapMessage(filename: string, cap: number): string {
  return `${filename}: archive expands beyond the ${cap} byte cap`;
}

/** True when a unix mode (number or octal string) marks a symlink (S_IFLNK). */
export function isSymlinkMode(unixPermissions: number | string | null | undefined): boolean {
  const perms =
    typeof unixPermissions === 'string' ? parseInt(unixPermissions, 8) : unixPermissions;
  return typeof perms === 'number' && perms !== 0 && (perms & 0o170000) === 0o120000;
}

// --------------------------------------------------------------------- //
// ZIP32 central directory (declared-metadata pre-filter)
// --------------------------------------------------------------------- //

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP32_UINT16_MAX = 0xffff;
const ZIP32_UINT32_MAX = 0xffffffff;
/** Size of the fixed end-of-central-directory record. */
export const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
/** Longest possible zip comment; bounds the backward EOCD scan. */
export const MAX_ZIP_COMMENT = 0xffff;

/** One central-directory record, as declared by the archive. */
export interface CentralDirectoryEntry {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** General-purpose bit flag (bit 0 = encrypted, bit 3 = data descriptor). */
  flags: number;
  /** 0 = stored, 8 = deflate; anything else is refused by the extractors. */
  compressionMethod: number;
  /** Declared offset of the local file header (relative to the declared archive start). */
  localHeaderOffset: number;
  /** Host system byte of "version made by" (0 = MS-DOS, 3 = UNIX). */
  madeBy: number;
  externalAttributes: number;
}

export interface CentralDirectory {
  entries: CentralDirectoryEntry[];
  /**
   * Bytes prepended to the archive (self-extracting prefixes): the found
   * central directory start minus its DECLARED offset. Local header offsets
   * are shifted by exactly this amount.
   */
  prefixBytes: number;
}

function u16(buf: Uint8Array, pos: number): number {
  return (buf[pos] ?? 0) | ((buf[pos + 1] ?? 0) << 8);
}

function u32(buf: Uint8Array, pos: number): number {
  return (
    ((buf[pos] ?? 0) | ((buf[pos + 1] ?? 0) << 8) | ((buf[pos + 2] ?? 0) << 16)) +
    (buf[pos + 3] ?? 0) * 0x1000000
  );
}

/** Read a little-endian uint16 (exported for the browser's local-header reads). */
export function readUint16LE(buf: Uint8Array, pos: number): number {
  return u16(buf, pos);
}

/** Read a little-endian uint32 (exported for the browser's local-header reads). */
export function readUint32LE(buf: Uint8Array, pos: number): number {
  return u32(buf, pos);
}

/**
 * Locate the ZIP32 end-of-central-directory record by BACKWARD signature
 * scan, honoring the trailing comment length (the record must sit exactly
 * `22 + commentLength` bytes from the end of `buf`). Returns the record's
 * offset within `buf`, or -1 when no valid record exists.
 */
export function findEocdOffset(buf: Uint8Array): number {
  if (buf.length < EOCD_SIZE) return -1;
  const highest = buf.length - EOCD_SIZE;
  const floor = Math.max(0, buf.length - EOCD_SIZE - MAX_ZIP_COMMENT);
  for (let pos = highest; pos >= floor; pos -= 1) {
    if (u32(buf, pos) !== EOCD_SIGNATURE) continue;
    if (u16(buf, pos + 20) === buf.length - pos - EOCD_SIZE) return pos;
  }
  return -1;
}

/** Declared central-directory size of the EOCD record at `eocd` within `buf`. */
export function centralDirectorySizeAt(buf: Uint8Array, eocd: number): number {
  return u32(buf, eocd + 12);
}

/**
 * Walk the ZIP32 central directory and return every declared entry. `buf`
 * must END with the archive's end (the EOCD record plus its comment) and
 * contain the whole central directory; `bufStart` is the absolute archive
 * offset of buf[0] (0 when buf is the whole archive). Central-directory
 * declared sizes are authoritative even for bit-3 data-descriptor entries.
 *
 * ZIP32-only: a ZIP64 marker (0xffffffff fields in the EOCD, a ZIP64 EOCD
 * locator, or 0xffffffff sizes in a central header) is REFUSED, never
 * misparsed. Duplicate entry names are refused (extraction is last-write-wins,
 * so a benign first entry must not mask a hostile duplicate).
 */
export function parseCentralDirectory(
  buf: Uint8Array,
  filename: string,
  fail: FailFactory,
  bufStart = 0,
): CentralDirectory {
  const eocd = findEocdOffset(buf);
  if (eocd < 0) {
    throw fail(`${filename}: not a readable zip archive (no end-of-central-directory record)`);
  }
  const zip64Refusal = `${filename}: ZIP64 markers are refused; pack archives above 4 GiB / 65535 entries are not accepted`;
  if (
    u16(buf, eocd + 8) === ZIP32_UINT16_MAX ||
    u16(buf, eocd + 10) === ZIP32_UINT16_MAX ||
    u32(buf, eocd + 12) === ZIP32_UINT32_MAX ||
    u32(buf, eocd + 16) === ZIP32_UINT32_MAX
  ) {
    throw fail(zip64Refusal);
  }
  // A ZIP64 EOCD locator sits immediately before the (32-bit) EOCD.
  if (eocd >= 20 && u32(buf, eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw fail(zip64Refusal);
  }
  const totalEntries = u16(buf, eocd + 10);
  const centralSize = u32(buf, eocd + 12);
  const declaredCentralOffset = u32(buf, eocd + 16);
  // Anchor on the found record, not the declared offset: with prepended
  // bytes the declared offset is shifted by exactly the prefix length.
  const centralStart = eocd - centralSize;
  if (centralStart < 0 || centralSize > eocd) {
    throw fail(`${filename}: malformed zip central directory (declared size overruns the archive)`);
  }
  const entries: CentralDirectoryEntry[] = [];
  const seenNames = new Set<string>();
  const decoder = new TextDecoder('utf-8');
  let pos = centralStart;
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + CENTRAL_HEADER_SIZE > eocd) {
      throw fail(`${filename}: malformed zip central directory (truncated header)`);
    }
    if (u32(buf, pos) !== CENTRAL_SIGNATURE) {
      throw fail(`${filename}: malformed zip central directory (bad header signature)`);
    }
    const nameLength = u16(buf, pos + 28);
    const extraLength = u16(buf, pos + 30);
    const commentLength = u16(buf, pos + 32);
    const uncompressedSize = u32(buf, pos + 24);
    const compressedSize = u32(buf, pos + 20);
    if (uncompressedSize === ZIP32_UINT32_MAX || compressedSize === ZIP32_UINT32_MAX) {
      throw fail(zip64Refusal);
    }
    const nameStart = pos + CENTRAL_HEADER_SIZE;
    if (nameStart + nameLength > eocd) {
      throw fail(`${filename}: malformed zip central directory (truncated name)`);
    }
    const name = decoder.decode(buf.subarray(nameStart, nameStart + nameLength));
    if (seenNames.has(name)) {
      throw fail(`${filename}: duplicate archive entry ${name} is not allowed`);
    }
    seenNames.add(name);
    const externalAttributes = u32(buf, pos + 38);
    const mode = externalAttributes >>> 16;
    entries.push({
      name,
      uncompressedSize,
      compressedSize,
      isDirectory: name.endsWith('/') || (mode !== 0 && (mode & 0o170000) === 0o040000),
      isSymlink: mode !== 0 && (mode & 0o170000) === 0o120000,
      flags: u16(buf, pos + 8),
      compressionMethod: u16(buf, pos + 10),
      localHeaderOffset: u32(buf, pos + 42),
      madeBy: (u16(buf, pos + 4) >>> 8) & 0xff,
      externalAttributes,
    });
    pos += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return { entries, prefixBytes: bufStart + centralStart - declaredCentralOffset };
}

/**
 * Declared-metadata pre-filter: entry count, total declared uncompressed
 * size, and aggregate declared compression ratio over the raw central
 * directory, all BEFORE any decompression work.
 */
export function enforceDeclaredLimits(
  entries: readonly CentralDirectoryEntry[],
  limits: PackSecurityLimits,
  filename: string,
  fail: FailFactory,
): void {
  if (entries.length > limits.maxEntries) {
    throw fail(`${filename}: archive declares ${entries.length} entries, over the ${limits.maxEntries} entry cap`);
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
    throw fail(
      `${filename}: archive declares ${totalUncompressed} uncompressed bytes, over the ${limits.maxUncompressedBytes} byte cap`,
    );
  }
  // Only real payloads count toward the ratio. A declared payload with zero
  // compressed bytes is a malformed or crafted record; fail closed.
  const ratioEnforced = ratioUncompressed >= RATIO_FLOOR_BYTES;
  if (ratioEnforced && (ratioCompressed === 0 || ratioUncompressed / ratioCompressed > limits.maxCompressionRatio)) {
    const ratio = ratioCompressed === 0 ? Number.POSITIVE_INFINITY : ratioUncompressed / ratioCompressed;
    throw fail(
      `${filename}: archive declares a ${ratio.toFixed(1)}:1 compression ratio, over the ${limits.maxCompressionRatio}:1 cap (possible zip bomb)`,
    );
  }
}

/**
 * The raw-name stage both extractors run right after the declared-limit
 * pre-filter: every entry name validated, every symlink refused.
 */
export function enforceEntryNames(
  entries: readonly CentralDirectoryEntry[],
  filename: string,
  fail: FailFactory,
): void {
  for (const entry of entries) {
    checkEntryName(entry.name, fail);
    if (entry.isSymlink) {
      throw fail(symlinkEntryMessage(filename, entry.name));
    }
  }
}
