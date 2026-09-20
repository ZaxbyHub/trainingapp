// packs/zip-install.ts — thin re-export seam (issue #75, C8).
//
// The zip-upload extraction implementation MOVED to pack-extract.ts (the
// shared extraction-safety + pack-security core) so the extractor and
// PackManager's install-time gates cannot drift. This module keeps its
// historical path and exports so existing importers (surface.ts, the frozen
// check drivers) resolve unchanged; the guard set and its documentation now
// live in pack-extract.ts:
//   G1 root-level pack.json manifest presence,
//   G2 safeEntryName + ensureContained resolved-path containment (per-entry,
//      BEFORE any write; drive-relative/absolute names refused),
//   G3 symlink entries refused (raw unix mode AND the parsed view),
//   G4 declared-size pre-filter via the ZIP32 central-directory parser,
//   G5 declared compression-ratio pre-filter,
//   G6 written-bytes total cap (unspoofable backstop),
//   plus config-driven limits (TRAININGAPP_PACKS_* env /
//   BackendHostConfig.packsSecurity) and ZIP64 refusal.
export {
  extractPackZip,
  isZipFilename,
  isSymlinkEntry,
  safeEntryName,
  ensureContained,
  parseZip32CentralDirectory,
  enforceDeclaredLimits,
  resolvePackLimits,
  resolvePacksSecurity,
  modelIdMatches,
  canonicalManifestBytes,
  verifyPackSignature,
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_PACKS_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
  DEFAULT_PACK_EMBEDDING_MODEL_ID,
  type PackSecurityLimits,
  type TrustedPackKey,
  type PacksSecurityOverrides,
  type ResolvedPacksSecurity,
  type CentralDirectoryEntry,
} from './pack-extract.js';
