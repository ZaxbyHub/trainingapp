// pack-extract-browser.ts — the browser twin of the desktop pack extractor
// (desktop/main/backend/packs/pack-extract.ts), trace browser-training-parity
// AC1.
//
// Same guards, same order, same error class name and message text as desktop:
//   1. .zip extension gate;
//   2. ZIP32 central-directory pre-filter over the RAW archive bytes, BEFORE
//      any decompression: declared entry count, declared total size, declared
//      aggregate compression ratio (16 MiB floor), ZIP64 refusal, duplicate
//      names (./pack-archive-rules.ts, byte-identical to the desktop twin);
//   3. raw entry-name validation (traversal, absolute, drive-relative,
//      backslash, control characters) and symlink refusal;
//   4. the decompressor-view checks desktop gets from JSZip (encrypted
//      entries, unknown compression methods, uncompressed-size mismatch);
//   5. pack.json at the archive root;
//   6. the unspoofable written-bytes backstop while streaming.
//
// Unlike desktop (JSZip loads the whole archive), entries are read with
// central-directory-first random access over Blob.slice and streamed through
// the native DecompressionStream('deflate-raw'): at most one entry's
// compressed slice is in flight, so a 292 MB publish never materializes in
// memory. No dependency is added.
import {
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
  DEFAULT_PACKS_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  EOCD_SIZE,
  MAX_ZIP_COMMENT,
  centralDirectorySizeAt,
  enforceDeclaredLimits,
  enforceEntryNames,
  expandsBeyondCapMessage,
  findEocdOffset,
  isZipFilename,
  missingManifestMessage,
  notZipMessage,
  parseCentralDirectory,
  readUint16LE,
  readUint32LE,
  type CentralDirectoryEntry,
  type PackSecurityLimits,
} from './pack-archive-rules';

export type { PackSecurityLimits } from './pack-archive-rules';

/** Raised for refused or failed pack operations (desktop parity name). */
export class PackManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackManagerError';
  }
}

const packError = (message: string): Error => new PackManagerError(message);

/** Defaults identical to desktop: 2 GiB / 5000 entries / 100:1. */
export const DEFAULT_PACK_LIMITS: PackSecurityLimits = {
  maxUncompressedBytes: DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  maxEntries: DEFAULT_PACKS_MAX_ENTRIES,
  maxCompressionRatio: DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
};

/**
 * Browser-only resource bound: the central directory is read into memory in
 * one piece, so its declared size is capped (a 5000-entry pack's directory is
 * well under 2 MiB). Desktop reads the WHOLE archive into memory instead, so
 * this bound is strictly tighter than desktop's memory exposure.
 */
export const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

/**
 * Browser-only resource bound for entries read fully into memory (pack.json
 * and the manifest's docs, which must be hashed whole): 256 MiB. Player
 * assets are streamed to storage and never held whole.
 */
export const MAX_IN_MEMORY_ENTRY_BYTES = 256 * 1024 * 1024;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;

/** Random-access view of an archive (a File/Blob in production, bytes in tests). */
export interface ArchiveSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  stream(start: number, end: number): ReadableStream<Uint8Array>;
}

export function sourceFromBlob(blob: Blob): ArchiveSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    stream: (start, end) => blob.slice(start, end).stream() as ReadableStream<Uint8Array>,
  };
}

export function sourceFromBytes(bytes: Uint8Array): ArchiveSource {
  // Copy into a fresh ArrayBuffer-backed view so Blob gets a plain buffer.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return sourceFromBlob(new Blob([owned]));
}

/** One file entry that survived every pre-decompression guard. */
export interface ArchiveFileEntry {
  /** The raw (validated) entry name, e.g. 'assets/player/story.html'. */
  name: string;
  /** Path segments to write (empty segments collapsed, like JSZip). */
  segments: string[];
  uncompressedSize: number;
  compressedSize: number;
  method: 0 | 8;
  /** Absolute archive offset of the entry's local file header. */
  localHeaderOffset: number;
}

export interface OpenedArchive {
  readonly filename: string;
  readonly limits: PackSecurityLimits;
  /** File entries only (directory entries are skipped, like desktop). */
  readonly files: readonly ArchiveFileEntry[];
  /** The root pack.json entry. */
  readonly manifestEntry: ArchiveFileEntry;
  /**
   * Stream one entry's decompressed bytes to `onChunk`. Enforces the
   * per-entry declared size and the archive-wide written-bytes backstop.
   */
  pipeEntry(entry: ArchiveFileEntry, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void>;
  /** Read one (small) entry fully into memory under the same guards. */
  readEntry(entry: ArchiveFileEntry): Promise<Uint8Array>;
  /** Uncompressed bytes produced so far across every pipeEntry/readEntry call. */
  writtenBytes(): number;
}

function resolveLimits(limits?: Partial<PackSecurityLimits>): PackSecurityLimits {
  return {
    maxUncompressedBytes: limits?.maxUncompressedBytes ?? DEFAULT_PACK_LIMITS.maxUncompressedBytes,
    maxEntries: limits?.maxEntries ?? DEFAULT_PACK_LIMITS.maxEntries,
    maxCompressionRatio: limits?.maxCompressionRatio ?? DEFAULT_PACK_LIMITS.maxCompressionRatio,
  };
}

/** JSZip's directory rule (the desktop decompressor view): DOS dir bit or a trailing slash. */
function isDirectoryEntryForWrite(entry: CentralDirectoryEntry): boolean {
  return (entry.externalAttributes & 0x10) !== 0 || entry.name.endsWith('/');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open an archive: run every pre-decompression guard (extension, central
 * directory, declared limits, entry names, symlinks, decompressor support,
 * pack.json presence) and return a handle that streams entries under the
 * size guards. Every refusal is a PackManagerError.
 */
export async function openPackArchive(
  source: ArchiveSource,
  filename: string,
  limits?: Partial<PackSecurityLimits>,
): Promise<OpenedArchive> {
  if (!isZipFilename(filename)) {
    throw new PackManagerError(notZipMessage(filename));
  }
  const resolved = resolveLimits(limits);

  // Central directory, read tail-first: the EOCD record sits within the last
  // 22 + 65535 bytes; the directory window then spans [cdStart - 20, end).
  const tailLength = Math.min(source.size, EOCD_SIZE + MAX_ZIP_COMMENT);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, source.size);
  const eocdInTail = findEocdOffset(tail);
  let windowStart = 0;
  let window = tail;
  if (eocdInTail >= 0) {
    const eocdAbsolute = tailStart + eocdInTail;
    const centralSize = centralDirectorySizeAt(tail, eocdInTail);
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new PackManagerError(
        `${filename}: malformed zip central directory (declared ${centralSize} bytes, over the ${MAX_CENTRAL_DIRECTORY_BYTES} byte browser read bound)`,
      );
    }
    windowStart = Math.max(0, eocdAbsolute - centralSize - 20);
    window = windowStart >= tailStart ? tail.subarray(windowStart - tailStart) : await source.read(windowStart, source.size);
  }
  const directory = parseCentralDirectory(window, filename, packError, windowStart);
  enforceDeclaredLimits(directory.entries, resolved, filename, packError);
  enforceEntryNames(directory.entries, filename, packError);

  // Decompressor-view checks (what JSZip refuses on desktop at load time).
  const files: ArchiveFileEntry[] = [];
  for (const entry of directory.entries) {
    if ((entry.flags & 0x0001) !== 0) {
      throw new PackManagerError(`${filename}: not a readable zip archive: Encrypted zip are not supported`);
    }
    if (isDirectoryEntryForWrite(entry)) continue;
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new PackManagerError(
        `${filename}: not a readable zip archive: Corrupted zip : compression ${entry.compressionMethod} unknown (inner file : ${entry.name})`,
      );
    }
    files.push({
      name: entry.name,
      segments: entry.name.split('/').filter((segment) => segment.length > 0),
      uncompressedSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      method: entry.compressionMethod as 0 | 8,
      localHeaderOffset: entry.localHeaderOffset + directory.prefixBytes,
    });
  }

  const manifestEntry = files.find((entry) => entry.name === 'pack.json');
  if (manifestEntry === undefined) {
    throw new PackManagerError(missingManifestMessage(filename));
  }

  let written = 0;
  const dataRange = async (entry: ArchiveFileEntry): Promise<[number, number]> => {
    const start = entry.localHeaderOffset;
    if (start < 0 || start + LOCAL_HEADER_SIZE > source.size) {
      throw new PackManagerError(`${filename}: not a readable zip archive: local header of ${entry.name} is outside the archive`);
    }
    const header = await source.read(start, start + LOCAL_HEADER_SIZE);
    if (readUint32LE(header, 0) !== LOCAL_HEADER_SIGNATURE) {
      throw new PackManagerError(`${filename}: not a readable zip archive: bad local header signature for ${entry.name}`);
    }
    const dataStart = start + LOCAL_HEADER_SIZE + readUint16LE(header, 26) + readUint16LE(header, 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > source.size) {
      throw new PackManagerError(`${filename}: not a readable zip archive: data of ${entry.name} overruns the archive`);
    }
    return [dataStart, dataEnd];
  };

  const pipeEntry = async (
    entry: ArchiveFileEntry,
    onChunk: (chunk: Uint8Array) => Promise<void> | void,
  ): Promise<void> => {
    const [dataStart, dataEnd] = await dataRange(entry);
    let stream = source.stream(dataStart, dataEnd);
    if (entry.method === 8) {
      stream = stream.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
    }
    const reader = stream.getReader();
    let entryBytes = 0;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          throw new PackManagerError(`${filename}: extraction failed: ${entry.name}: ${errorText(error)}`);
        }
        if (step.done) break;
        const chunk = step.value;
        entryBytes += chunk.byteLength;
        // Per-entry: the decompressor view refuses an entry that inflates
        // past its declared size (JSZip's size-mismatch refusal), checked
        // per chunk so a lying entry is cut off at its declared length.
        if (entryBytes > entry.uncompressedSize) {
          throw new PackManagerError(
            `${filename}: extraction failed: uncompressed data size mismatch for ${entry.name} (declared ${entry.uncompressedSize} bytes)`,
          );
        }
        // Archive-wide: the unspoofable written-bytes backstop.
        written += chunk.byteLength;
        if (written > resolved.maxUncompressedBytes) {
          throw new PackManagerError(expandsBeyondCapMessage(filename, resolved.maxUncompressedBytes));
        }
        await onChunk(chunk);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof PackManagerError) throw error;
      throw new PackManagerError(`${filename}: extraction failed: ${errorText(error)}`);
    } finally {
      reader.releaseLock();
    }
    if (entryBytes !== entry.uncompressedSize) {
      throw new PackManagerError(
        `${filename}: extraction failed: uncompressed data size mismatch for ${entry.name} (declared ${entry.uncompressedSize}, actual ${entryBytes})`,
      );
    }
  };

  const readEntry = async (entry: ArchiveFileEntry): Promise<Uint8Array> => {
    if (entry.uncompressedSize > MAX_IN_MEMORY_ENTRY_BYTES) {
      throw new PackManagerError(
        `${filename}: extraction failed: ${entry.name} declares ${entry.uncompressedSize} bytes, over the ${MAX_IN_MEMORY_ENTRY_BYTES} byte in-memory read bound`,
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    await pipeEntry(entry, (chunk) => {
      chunks.push(chunk);
      total += chunk.byteLength;
    });
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  return {
    filename,
    limits: resolved,
    files,
    manifestEntry,
    pipeEntry,
    readEntry,
    writtenBytes: () => written,
  };
}

/** The in-memory result of extractPackZip (tests, small archives). */
export interface ExtractedPack {
  /** Entry name -> bytes, for every file entry. */
  files: Map<string, Uint8Array>;
}

/**
 * Frozen C1 signature: extract a pack zip held in memory, refusing it exactly
 * like desktop extractPackZip. A thin wrapper over openPackArchive; production
 * installs stream entries to origin-private storage instead
 * (./browser-pack-manager.ts).
 */
export async function extractPackZip(
  zip: Uint8Array,
  filename: string,
  limits?: Partial<PackSecurityLimits>,
): Promise<ExtractedPack> {
  const archive = await openPackArchive(sourceFromBytes(zip), filename, limits);
  const files = new Map<string, Uint8Array>();
  for (const entry of archive.files) {
    files.set(entry.segments.join('/'), await archive.readEntry(entry));
  }
  return { files };
}
