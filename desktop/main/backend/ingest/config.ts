// ingest/config.ts — ingest pipeline configuration (issue #64, B6).
//
// Env-var ingress mirrors the backend's established pattern
// (TRAININGAPP_DESKTOP_INFERENCE_* in inference/profile-select.ts): explicit
// positive integers only; any invalid value falls back to that key's default
// so an operator typo can never produce an invalid chunker pair. The
// cross-field invariant (overlap must be < word count) is enforced AFTER
// resolution: if the resolved pair violates it, BOTH fall back to defaults.
// maxConcurrentFiles is coordinated with B8's runtime budget (issue #66).

export interface IngestConfig {
  /** Files processed concurrently during directory ingestion. */
  maxConcurrentFiles: number;
  /** Target words per chunk (characters for CJK-dense text — text-chunker). */
  chunkWordCount: number;
  /** Overlapping words between consecutive chunks. */
  chunkOverlapWords: number;
}

export const DEFAULT_INGEST_CONFIG: Readonly<IngestConfig> = Object.freeze({
  maxConcurrentFiles: 2,
  chunkWordCount: 256,
  chunkOverlapWords: 100,
});

export const INGEST_MAX_CONCURRENT_FILES_ENV = 'TRAININGAPP_INGEST_MAX_CONCURRENT_FILES';
export const INGEST_CHUNK_WORD_COUNT_ENV = 'TRAININGAPP_INGEST_CHUNK_WORD_COUNT';
export const INGEST_CHUNK_OVERLAP_WORDS_ENV = 'TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS';

/** Resource caps for one ingest operation (extraction-bomb defense). */
export interface IngestLimits {
  /** Refuse files larger than this many bytes, in EVERY ingest mode. */
  maxFileBytes: number;
  /** Refuse zip-based docs (docx/xlsx/pptx) whose declared entries decompress beyond this. */
  maxZipBytes: number;
  /** Refuse documents whose extracted text exceeds this many characters. */
  maxTextChars: number;
}

export const DEFAULT_INGEST_LIMITS: Readonly<IngestLimits> = Object.freeze({
  maxFileBytes: 60 * 1024 * 1024,
  maxZipBytes: 512 * 1024 * 1024,
  maxTextChars: 8_000_000,
});

export const INGEST_MAX_FILE_BYTES_ENV = 'TRAININGAPP_INGEST_MAX_FILE_BYTES';
export const INGEST_MAX_ZIP_BYTES_ENV = 'TRAININGAPP_INGEST_MAX_ZIP_BYTES';
export const INGEST_MAX_TEXT_CHARS_ENV = 'TRAININGAPP_INGEST_MAX_TEXT_CHARS';

/** Parse one positive-integer env value; anything else is rejected (not clamped). */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return value >= 1 ? value : undefined;
}

/** Resolve the ingest config: explicit env values beat the frozen defaults. */
export function resolveIngestConfig(env: Record<string, string | undefined> = process.env): IngestConfig {
  let maxConcurrentFiles =
    positiveInt(env[INGEST_MAX_CONCURRENT_FILES_ENV]) ?? DEFAULT_INGEST_CONFIG.maxConcurrentFiles;
  let chunkWordCount = positiveInt(env[INGEST_CHUNK_WORD_COUNT_ENV]) ?? DEFAULT_INGEST_CONFIG.chunkWordCount;
  let chunkOverlapWords = positiveInt(env[INGEST_CHUNK_OVERLAP_WORDS_ENV]) ?? DEFAULT_INGEST_CONFIG.chunkOverlapWords;
  if (chunkOverlapWords >= chunkWordCount) {
    // The TextChunker constructor rejects overlap >= size, so an env pair that
    // would violate the invariant (including a valid overlap vs a default
    // word count) falls back to the coherent defaults rather than crashing
    // every ingest.
    chunkWordCount = DEFAULT_INGEST_CONFIG.chunkWordCount;
    chunkOverlapWords = DEFAULT_INGEST_CONFIG.chunkOverlapWords;
  }
  if (maxConcurrentFiles < 1) maxConcurrentFiles = DEFAULT_INGEST_CONFIG.maxConcurrentFiles;
  return { maxConcurrentFiles, chunkWordCount, chunkOverlapWords };
}

/**
 * Resolve the extraction resource caps. Deliberately SEPARATE from
 * resolveIngestConfig: the frozen acceptance pin expects that resolver to
 * return exactly the three documented ingest.* keys, and the caps are a
 * review-hardening surface (PRR-005) with their own env overrides.
 */
export function resolveIngestLimits(env: Record<string, string | undefined> = process.env): IngestLimits {
  return {
    maxFileBytes: positiveInt(env[INGEST_MAX_FILE_BYTES_ENV]) ?? DEFAULT_INGEST_LIMITS.maxFileBytes,
    maxZipBytes: positiveInt(env[INGEST_MAX_ZIP_BYTES_ENV]) ?? DEFAULT_INGEST_LIMITS.maxZipBytes,
    maxTextChars: positiveInt(env[INGEST_MAX_TEXT_CHARS_ENV]) ?? DEFAULT_INGEST_LIMITS.maxTextChars,
  };
}
