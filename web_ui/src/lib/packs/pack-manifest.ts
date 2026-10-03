// pack-manifest.ts — browser twin of the desktop PackManager install gates
// (desktop/main/backend/store/pack-manager.ts validatedManifest), trace
// browser-training-parity AC1/AC2.
//
// Same order and the same refusal text as desktop:
//   parse (UTF-8, fatal) -> contracts/pack.schema.json -> safe doc paths +
//   duplicate paths + per-doc sha256 re-hash -> index-path safety -> index
//   schema_version -> sqlite-vec stamp -> embedding-model pin -> opt-in
//   signature gate.
// The JSON Schema is mirrored by hand (web_ui carries no ajv); the desktop
// drift test (desktop/src/__tests__/browser-pack-schema-drift.test.ts) runs
// generated documents through BOTH this validator and ajv on the real schema
// file and fails on any verdict difference.
import { PackManagerError } from './pack-extract-browser';
import { enforceSignaturePolicy, type SignaturePolicy } from './pack-verify';

/** Desktop PACKS_SQLITE_VEC_PIN (pack-manager.ts). */
export const PACKS_SQLITE_VEC_PIN = '0.1.9';
/** Desktop store schema version (contracts/store.schema.sql meta.schema_version). */
export const PACK_STORE_SCHEMA_VERSION = 3;
/** Desktop DEFAULT_PACK_EMBEDDING_MODEL_ID (pack-extract.ts, ADR-0006). */
export const DEFAULT_PACK_EMBEDDING_MODEL_ID = 'bge-small-en-v1.5';

export interface PackDocEntry {
  path: string;
  sha256: string;
  title: string;
  mime: string;
  published_at?: string;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  published_at: string;
  source_class: 'bundled' | 'training' | 'user';
  supersedes?: string[];
  embedding: { model_id: string; dims: number; normalize: boolean };
  chunking: { strategy: string; size: number; overlap: number };
  docs: PackDocEntry[];
  index?: { path: string; schema_version: number; sqlite_vec_version: string };
  signature?: { algorithm?: string; value?: string; key_id?: string };
}

// --------------------------------------------------------------------- //
// JSON Schema mirror (draft 2020-12 semantics as ajv applies them)
// --------------------------------------------------------------------- //

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/u;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u;
const SUPERSEDES_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** ajv counts string length in code points (ucs2length), not UTF-16 units. */
const codePoints = (v: string): number => Array.from(v).length;
const onlyKeys = (v: Json, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));
const hasKeys = (v: Json, required: readonly string[]): boolean =>
  required.every((k) => Object.prototype.hasOwnProperty.call(v, k));

// ajv-formats "date-time" (full mode, strict time zone), ported verbatim in
// behavior from ajv-formats/dist/formats.js (MIT).
const DATE_RE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TIME_RE = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
function isDate(str: string): boolean {
  const m = DATE_RE.exec(str);
  if (!m) return false;
  const year = +m[1]!;
  const month = +m[2]!;
  const day = +m[3]!;
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : (DAYS[month] ?? 0));
}
function isTime(str: string): boolean {
  const m = TIME_RE.exec(str);
  if (!m) return false;
  const hr = +m[1]!;
  const min = +m[2]!;
  const sec = +m[3]!;
  const tz = m[4];
  const tzSign = m[5] === '-' ? -1 : 1;
  const tzH = +(m[6] || 0);
  const tzM = +(m[7] || 0);
  if (tzH > 23 || tzM > 59 || !tz) return false;
  if (hr <= 23 && min <= 59 && sec < 60) return true;
  const utcMin = min - tzM * tzSign;
  const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
}
/** RFC 3339 date-time exactly as ajv-formats validates the schema's `format: date-time`. */
export function isDateTime(str: string): boolean {
  const parts = str.split(/t|\s/i);
  return parts.length === 2 && isDate(parts[0]!) && isTime(parts[1]!);
}

/** contracts/pack.schema.json, mirrored. True iff ajv would accept `value`. */
export function validateManifestSchema(value: unknown): value is PackManifest {
  if (!isObject(value)) return false;
  const required = ['id', 'name', 'version', 'published_at', 'source_class', 'embedding', 'chunking', 'docs'];
  const allowed = [...required, 'supersedes', 'index', 'signature'];
  if (!hasKeys(value, required) || !onlyKeys(value, allowed)) return false;
  if (!isString(value.id) || !ID_RE.test(value.id)) return false;
  if (!isString(value.name) || codePoints(value.name) < 1 || codePoints(value.name) > 200) return false;
  if (!isString(value.version) || !SEMVER_RE.test(value.version)) return false;
  if (!isString(value.published_at) || !isDateTime(value.published_at)) return false;
  if (!isString(value.source_class) || !['bundled', 'training', 'user'].includes(value.source_class)) return false;
  if ('supersedes' in value) {
    const s = value.supersedes;
    if (!Array.isArray(s) || !s.every((item) => isString(item) && SUPERSEDES_RE.test(item))) return false;
  }
  const embedding = value.embedding;
  if (
    !isObject(embedding) ||
    !hasKeys(embedding, ['model_id', 'dims', 'normalize']) ||
    !onlyKeys(embedding, ['model_id', 'dims', 'normalize']) ||
    !isString(embedding.model_id) ||
    codePoints(embedding.model_id) < 1 ||
    !isInteger(embedding.dims) ||
    embedding.dims < 1 ||
    typeof embedding.normalize !== 'boolean'
  ) {
    return false;
  }
  const chunking = value.chunking;
  if (
    !isObject(chunking) ||
    !hasKeys(chunking, ['strategy', 'size', 'overlap']) ||
    !onlyKeys(chunking, ['strategy', 'size', 'overlap']) ||
    !isString(chunking.strategy) ||
    !['fixed-words', 'fixed-tokens', 'page-aware', 'slide-aware'].includes(chunking.strategy) ||
    !isInteger(chunking.size) ||
    chunking.size < 1 ||
    !isInteger(chunking.overlap) ||
    chunking.overlap < 0
  ) {
    return false;
  }
  const docs = value.docs;
  if (!Array.isArray(docs) || docs.length < 1) return false;
  for (const doc of docs) {
    if (
      !isObject(doc) ||
      !hasKeys(doc, ['path', 'sha256', 'title', 'mime']) ||
      !onlyKeys(doc, ['path', 'sha256', 'title', 'published_at', 'mime']) ||
      !isString(doc.path) ||
      codePoints(doc.path) < 1 ||
      !isString(doc.sha256) ||
      !SHA256_RE.test(doc.sha256) ||
      !isString(doc.title) ||
      codePoints(doc.title) < 1 ||
      !isString(doc.mime) ||
      codePoints(doc.mime) < 1
    ) {
      return false;
    }
    if ('published_at' in doc && (!isString(doc.published_at) || !isDateTime(doc.published_at))) return false;
  }
  if ('index' in value) {
    const index = value.index;
    if (
      !isObject(index) ||
      !hasKeys(index, ['path', 'schema_version', 'sqlite_vec_version']) ||
      !onlyKeys(index, ['path', 'schema_version', 'sqlite_vec_version']) ||
      !isString(index.path) ||
      codePoints(index.path) < 1 ||
      !isInteger(index.schema_version) ||
      index.schema_version < 1 ||
      !isString(index.sqlite_vec_version) ||
      codePoints(index.sqlite_vec_version) < 1
    ) {
      return false;
    }
  }
  if ('signature' in value) {
    const signature = value.signature;
    if (!isObject(signature)) return false;
    for (const key of ['algorithm', 'value', 'key_id']) {
      if (key in signature && !isString(signature[key])) return false;
    }
  }
  return true;
}

// --------------------------------------------------------------------- //
// semantic gates (desktop pack-manager.ts ports)
// --------------------------------------------------------------------- //

/** Refuse absolute paths, backslashes, dot segments, NUL and control chars (desktop text). */
export function assertSafeDocPath(value: string): void {
  if (value.length === 0) throw new PackManagerError('doc path is empty');
  if (value.includes('\\')) throw new PackManagerError(`doc path has a backslash: ${value}`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new PackManagerError(`doc path is absolute: ${value}`);
  }
  for (const segment of value.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new PackManagerError(`doc path has a dot segment: ${value}`);
    }
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0 || code < 32 || code === 127) {
      throw new PackManagerError(`doc path has a control character: ${JSON.stringify(value)}`);
    }
  }
}

/** Canonical embedding-model comparison: strip through the last '/', casefold. */
export function modelIdMatches(declared: string, expected: string): boolean {
  const canonical = (value: string): string => {
    const slash = value.lastIndexOf('/');
    return (slash >= 0 ? value.slice(slash + 1) : value).trim().toLowerCase();
  };
  return canonical(declared) === canonical(expected);
}

type PreId = [number, number, string];
export interface VersionKey {
  major: number;
  minor: number;
  patch: number;
  pre: number;
  ids: PreId[];
}

/** Mirror of desktop versionKey: semver 2.0.0 precedence key. */
export function versionKey(version: string): VersionKey {
  let core = version;
  const plus = core.indexOf('+');
  if (plus >= 0) core = core.slice(0, plus);
  let pre = '';
  const dash = core.indexOf('-');
  if (dash >= 0) {
    pre = core.slice(dash + 1);
    core = core.slice(0, dash);
  }
  const segments = core.split('.');
  if (segments.length !== 3 || segments.some((s) => !/^\d+$/.test(s))) {
    throw new PackManagerError(`unsupported pack version (semver 2.0.0 expected): ${version}`);
  }
  const ids: PreId[] =
    pre === ''
      ? []
      : pre.split('.').map((part) => (/^\d+$/.test(part) ? [0, Number.parseInt(part, 10), ''] : [1, 0, part]));
  return {
    major: Number.parseInt(segments[0] ?? '0', 10),
    minor: Number.parseInt(segments[1] ?? '0', 10),
    patch: Number.parseInt(segments[2] ?? '0', 10),
    pre: pre === '' ? 1 : 0,
    ids,
  };
}

function compareIds(a: PreId, b: PreId): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/** Negative when a < b, 0 when equal, positive when a > b (desktop compareVersionKeys). */
export function compareVersionKeys(a: VersionKey, b: VersionKey): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre !== b.pre) return a.pre - b.pre;
  const len = Math.min(a.ids.length, b.ids.length);
  for (let i = 0; i < len; i += 1) {
    const c = compareIds(a.ids[i]!, b.ids[i]!);
    if (c !== 0) return c;
  }
  return a.ids.length - b.ids.length;
}

export function compareVersions(a: string, b: string): number {
  return compareVersionKeys(versionKey(a), versionKey(b));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse raw pack.json bytes and validate the schema (desktop wording). */
export function parseManifest(raw: Uint8Array, label: string): PackManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (error) {
    throw new PackManagerError(
      `${label}: pack.json is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!validateManifestSchema(manifest)) {
    throw new PackManagerError('pack failed validation: pack.json does not satisfy contracts/pack.schema.json');
  }
  return manifest;
}

export interface ManifestGateConfig extends SignaturePolicy {
  embeddingModelId: string;
}

/**
 * The full desktop install gate sequence for an already schema-valid
 * manifest. `readDoc` returns a doc's bytes from the archive, or null when the
 * archive does not carry it.
 */
export async function validateManifestGates(
  manifest: PackManifest,
  raw: Uint8Array,
  label: string,
  readDoc: (path: string) => Promise<Uint8Array | null>,
  config: ManifestGateConfig,
): Promise<Map<string, Uint8Array>> {
  const seen = new Set<string>();
  const docs = new Map<string, Uint8Array>();
  for (const entry of manifest.docs) {
    assertSafeDocPath(entry.path);
    if (seen.has(entry.path)) {
      throw new PackManagerError(`${label}: duplicate docs[].path entries in manifest`);
    }
    seen.add(entry.path);
    const bytes = await readDoc(entry.path);
    if (bytes === null) {
      throw new PackManagerError(`doc unreadable: ${entry.path}: not present in the archive`);
    }
    const actual = await sha256Hex(bytes);
    if (actual !== entry.sha256.toLowerCase()) {
      throw new PackManagerError(`doc sha256 mismatch for ${entry.path}: manifest ${entry.sha256}, actual ${actual}`);
    }
    docs.set(entry.path, bytes);
  }
  if (manifest.index !== undefined) {
    assertSafeDocPath(manifest.index.path);
  }
  if (manifest.index !== undefined && manifest.index.schema_version !== PACK_STORE_SCHEMA_VERSION) {
    throw new PackManagerError(
      `pack index schema_version ${manifest.index.schema_version} does not match store schema_version ${PACK_STORE_SCHEMA_VERSION}; refusing install`,
    );
  }
  if (manifest.index !== undefined && manifest.index.sqlite_vec_version !== PACKS_SQLITE_VEC_PIN) {
    throw new PackManagerError(
      `pack index sqlite_vec_version ${manifest.index.sqlite_vec_version} does not match the pinned ${PACKS_SQLITE_VEC_PIN}; refusing install (rebuild the pack with the current toolchain)`,
    );
  }
  if (!modelIdMatches(manifest.embedding.model_id, config.embeddingModelId)) {
    throw new PackManagerError(
      `refusing to mix embedding spaces: ${manifest.id}@${manifest.version} was built with embedding model '${manifest.embedding.model_id}' but '${config.embeddingModelId}' is configured; rebuild the pack via packtool build-docs --embedding-model`,
    );
  }
  await enforceSignaturePolicy(raw, config);
  return docs;
}
