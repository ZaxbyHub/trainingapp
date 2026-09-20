/**
 * C8 (issue #75): archive-safety core for packtool verify — the same gate
 * matrix the install paths enforce (desktop/main/backend/packs/pack-extract.ts
 * and repo-root pack_extract.py), scoped to what an offline verifier can
 * check WITHOUT extracting: per-entry name safety, symlink entries, entry
 * count, and declared size/ratio limits read from the ZIP32 central
 * directory. packtool and desktop are separate npm packages with no shared
 * workspace root, so this module mirrors the twins' rules; behavioral parity
 * is pinned by the frozen C8/C11 checks and packtool's own vitest cases.
 *
 * ZIP32-only, matching the desktop twin: EOCD located by backward scan
 * (tolerates prepended bytes, honors the archive comment), central-directory
 * declared sizes are authoritative even for bit-3 data-descriptor entries,
 * and ZIP64 archives are refused explicitly rather than misparsed.
 */
import fs from 'node:fs';

export const VERIFY_MAX_ENTRIES = 5000;
export const VERIFY_MAX_UNCOMPRESSED_BYTES = 2147483648;
export const VERIFY_MAX_COMPRESSION_RATIO = 100;
const RATIO_FLOOR_BYTES = 16 * 1024 * 1024;

export interface ArchiveSafetyProblem {
  entry?: string;
  message: string;
}

const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const MAX_ZIP_COMMENT = 0xffff;

function isUnsafeEntryName(name: string): string | null {
  if (name.length === 0) return 'empty entry name';
  if (name.includes('\\')) return 'backslash in entry name';
  if (name.startsWith('/')) return 'absolute entry name';
  if (/^[A-Za-z]:/.test(name)) return 'drive-relative/absolute entry name';
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.') return 'dot segment in entry name';
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return 'control character in entry name';
  }
  return null;
}

function isSymlinkMode(externalAttrs: number): boolean {
  return ((externalAttrs >>> 16) & 0o170000) === 0o120000;
}

/**
 * Parse the ZIP32 central directory and enforce the install gate matrix on
 * declared metadata only (no entry is decompressed). Throws an Error whose
 * message names the refused entry or limit.
 */
export function assertArchiveSafety(zipPath: string, buffer?: Buffer): void {
  const data = buffer ?? fs.readFileSync(zipPath);
  // Backward EOCD scan: tolerant of prepended bytes; bounded by the maximum
  // archive comment length.
  const floor = Math.max(0, data.length - EOCD_SIZE - MAX_ZIP_COMMENT);
  let eocd = -1;
  for (let i = data.length - EOCD_SIZE; i >= floor; i -= 1) {
    if (data.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('archive is not a readable zip (no end-of-central-directory record)');
  }
  const entryCount = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('pack archives above 4 GiB / 65535 entries are not accepted (ZIP64)');
  }
  if (entryCount > VERIFY_MAX_ENTRIES) {
    throw new Error(
      `archive has ${entryCount} entries, over the ${VERIFY_MAX_ENTRIES} entry cap`,
    );
  }
  // A ZIP64 locator sitting directly before the EOCD is an unambiguous
  // ZIP64 marker even when the EOCD fields were clamped.
  const locator = eocd - 20;
  if (locator >= 0 && data.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error('pack archives above 4 GiB / 65535 entries are not accepted (ZIP64)');
  }
  // Anchor the walk at eocd - cdSize, NOT at the raw cdOffset: in a
  // prepended (SFX-style) archive cdOffset is relative to the ZIP payload,
  // and an attacker can prepend a DECOY central directory for naive parsers
  // while JSZip reads the real one. Deriving the start from the EOCD
  // position (mirroring the desktop twin) always lands on the true central
  // directory; the walk below must then consume EXACTLY cdSize bytes.
  const cdStart = eocd - cdSize;
  if (cdSize === 0 || cdStart < 0 || cdOffset > cdStart) {
    throw new Error('archive central directory is malformed (inconsistent size/offset)');
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  let cursor = cdStart;
  const cdEnd = eocd;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('archive central directory is malformed');
    }
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const externalAttrs = data.readUInt32LE(cursor + 38);
    const name = data.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`archive entry ${JSON.stringify(name)} uses ZIP64 sizes`);
    }
    const unsafe = isUnsafeEntryName(name);
    if (unsafe !== null) {
      throw new Error(`unsafe archive entry path ${name} (${unsafe})`);
    }
    if (isSymlinkMode(externalAttrs)) {
      throw new Error(`symlink archive entry ${name} is not allowed`);
    }
    const isDir = name.endsWith('/');
    if (!isDir) {
      totalUncompressed += uncompressedSize;
      totalCompressed += compressedSize;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== cdEnd) {
    throw new Error('archive central directory is malformed (size mismatch)');
  }
  if (totalUncompressed > VERIFY_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `archive expands beyond the ${VERIFY_MAX_UNCOMPRESSED_BYTES} byte cap`,
    );
  }
  if (totalCompressed <= 0) {
    if (totalUncompressed > 0) {
      throw new Error('archive declares compressed sizes of zero');
    }
  } else if (
    totalUncompressed >= RATIO_FLOOR_BYTES &&
    totalUncompressed / totalCompressed > VERIFY_MAX_COMPRESSION_RATIO
  ) {
    // Ratio only above an absolute floor: the byte cap bounds small
    // archives; legitimate sqlite vector pages exceed 100:1 on tiny indexes.
    throw new Error(
      `archive compression ratio exceeds the ${VERIFY_MAX_COMPRESSION_RATIO}:1 cap`,
    );
  }
}
