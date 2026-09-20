/**
 * Browser-side Knowledge Pack detection (ADR-0009, issue #76 / C9 PoC).
 *
 * This is a GATE-MESSAGE TRIGGER, not a validator: it answers exactly one
 * question — "does this dropped file carry the C1 Knowledge Pack manifest
 * signature (a zip whose root contains a schema-shaped pack.json)?" — so the
 * Documents page can tell the user that packs require the desktop app instead
 * of falling back to the generic unsupported-file-type rejection. It never
 * extracts archive entries to disk, never imports pack content, and NEVER
 * decides installability. Full validation (zip-safety G1-G6, signatures,
 * embedding-model gates) remains the desktop backend's job per
 * docs/security/packs.md and docs/adr/0009-browser-packs.md.
 *
 * Bounded by design: files larger than MAX_PACK_DETECT_BYTES are not even
 * buffered (a renderer tab must not materialize an arbitrary dropped archive
 * in memory just to decide whether to show a message). The residual
 * small-file/huge-expansion zip risk is accepted for this PoC and disclosed
 * in ADR-0009; JSZip here only parses the central directory and reads the
 * single root `pack.json` entry.
 */

import JSZip from 'jszip';

/** Files above this size are not inspected (renderer-memory bound). */
export const MAX_PACK_DETECT_BYTES = 256 * 1024 * 1024;

const PACK_MANIFEST_NAME = 'pack.json';

// The two cheap, load-bearing shape guards from contracts/pack.schema.json.
// Keep in sync with the schema file; this detector intentionally checks the
// minimum signature only (see header comment).
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Minimal C1 manifest-signature check: required top-level fields present with
 * plausible types, plus the id and sha256 patterns. Not a schema validator —
 * semver shape, published_at format, mime values, and cross-field semantics
 * are deliberately NOT checked here.
 */
export function looksLikePackManifest(manifest: unknown): boolean {
  if (!isPlainObject(manifest)) return false;
  const { id, name, version, published_at: publishedAt, source_class: sourceClass, embedding, chunking, docs } = manifest;
  if (typeof id !== 'string' || !PACK_ID_PATTERN.test(id)) return false;
  if (typeof name !== 'string' || name.length === 0) return false;
  if (typeof version !== 'string' || version.length === 0) return false;
  if (typeof publishedAt !== 'string' || publishedAt.length === 0) return false;
  if (sourceClass !== 'bundled' && sourceClass !== 'training' && sourceClass !== 'user') return false;
  if (!isPlainObject(embedding) || typeof embedding.model_id !== 'string' || typeof embedding.dims !== 'number') {
    return false;
  }
  if (!isPlainObject(chunking)) return false;
  if (!Array.isArray(docs) || docs.length === 0) return false;
  return docs.every((doc) => {
    if (!isPlainObject(doc)) return false;
    return (
      typeof doc.path === 'string' &&
      typeof doc.title === 'string' &&
      typeof doc.sha256 === 'string' &&
      SHA256_PATTERN.test(doc.sha256)
    );
  });
}

/**
 * True when `file` is a .zip carrying the Knowledge Pack manifest signature
 * (root `pack.json` matching the minimal C1 shape). Any read/parse/shape
 * failure returns false: the caller treats "not confidently a pack" as the
 * ordinary unsupported-file path.
 */
export async function isKnowledgePackZip(file: File): Promise<boolean> {
  if (!file.name.toLowerCase().endsWith('.zip')) return false;
  if (file.size > MAX_PACK_DETECT_BYTES) return false;
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const manifestEntry = zip.file(PACK_MANIFEST_NAME);
    if (!manifestEntry) return false;
    const manifestText = await manifestEntry.async('string');
    return looksLikePackManifest(JSON.parse(manifestText));
  } catch {
    return false;
  }
}
