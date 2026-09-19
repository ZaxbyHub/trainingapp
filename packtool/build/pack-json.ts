// build/pack-json.ts — the Knowledge Pack manifest (issue #79, D3).
//
// pack.json field shapes follow contracts/pack.schema.json (landed by #68/C1;
// this file is the Node-side structural mirror used by build and verify).
// Issue #73: chunking.strategy follows the C1 enum instead of the D3-era
// 'slide-aware' literal, so non-training packs stamp their real strategy.
//
// Determinism: serializePackJson emits fields in a fixed key order with the
// same JSON style as the extractor (2-space indent + trailing newline), and
// every pack-internal path is forward-slash normalized and traversed through
// assertSafeDocPath (compose AND verify share this single guardrail).

export const DOC_MIME = 'application/json';
export const SOURCE_CLASS_TRAINING = 'training';
export const SQLITE_VEC_PIN = '0.1.9';
/** v3 (C3/#70): per-version packs rows with active/install_path. */
export const STORE_SCHEMA_VERSION = 3;
export const INDEX_FILE_NAME = 'index.sqlite';
export const PACK_JSON_NAME = 'pack.json';
export const PLAYER_ASSETS_PREFIX = 'assets/player';
export const OUTLINE_DOC_PATH = 'docs/outline.json';

export interface PackEmbedding {
  /** Build embedder id; must match index.sqlite meta.embedding_model_id. */
  model_id: string;
  dims: number;
  normalize: boolean;
}

/**
 * Chunking strategies accepted in a manifest — the frozen C1 schema's enum
 * (contracts/pack.schema.json). Issue #73: widened from the build-storyline
 * literal 'slide-aware' so non-training packs can stamp their real strategy
 * ('fixed-words' is the plain-documents convention used by build-docs and
 * the bundled-min fixture).
 */
export const CHUNKING_STRATEGIES = ['fixed-words', 'fixed-tokens', 'page-aware', 'slide-aware'] as const;
export type ChunkingStrategy = (typeof CHUNKING_STRATEGIES)[number];

export interface PackChunking {
  strategy: ChunkingStrategy;
  size: number;
  overlap: number;
}

export interface PackDocEntry {
  /** Pack-relative path, forward slashes, no '..' segments. */
  path: string;
  /** sha256 of the raw doc file bytes (identity used for chunk ids). */
  sha256: string;
  title: string;
  mime: string;
}

export interface PackIndexEntry {
  path: string;
  schema_version: number;
  sqlite_vec_version: string;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  published_at: string;
  source_class: string;
  embedding: PackEmbedding;
  chunking: PackChunking;
  docs: PackDocEntry[];
  index?: PackIndexEntry;
}

/**
 * The pack's course-outline document (docs/outline.json) — a build-storyline
 * product, NOT D1's OutlineDoc (types.ts is untouched; extract output bytes
 * are pinned by the D1 goldens). `title` is carried explicitly so consumers
 * reading only docs/ see the course title without consulting pack.json.
 */
export interface PackOutlineDoc {
  title: string;
  course: string;
  duration: string;
  author?: string;
  scene_count: number;
  sections: Array<{ title: string; slide_count: number }>;
}

export function serializePackJson(manifest: PackManifest): string {
  // Fixed key order — construction order is the serialization order.
  const ordered: Record<string, unknown> = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    published_at: manifest.published_at,
    source_class: manifest.source_class,
    embedding: {
      model_id: manifest.embedding.model_id,
      dims: manifest.embedding.dims,
      normalize: manifest.embedding.normalize,
    },
    chunking: {
      strategy: manifest.chunking.strategy,
      size: manifest.chunking.size,
      overlap: manifest.chunking.overlap,
    },
    docs: manifest.docs.map((doc) => ({
      path: doc.path,
      sha256: doc.sha256,
      title: doc.title,
      mime: doc.mime,
    })),
    ...(manifest.index !== undefined
      ? {
          index: {
            path: manifest.index.path,
            schema_version: manifest.index.schema_version,
            sqlite_vec_version: manifest.index.sqlite_vec_version,
          },
        }
      : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function serializePackOutlineDoc(outline: PackOutlineDoc): string {
  const ordered: Record<string, unknown> = {
    title: outline.title,
    course: outline.course,
    duration: outline.duration,
    ...(outline.author !== undefined ? { author: outline.author } : {}),
    scene_count: outline.scene_count,
    sections: outline.sections.map((section) => ({
      title: section.title,
      slide_count: section.slide_count,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Issue #73: exported so build-docs validates a caller-supplied --id. */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Top-level fields the draft #68 manifest schema allows (required + the
 * optional supersedes/index/signature blocks). Anything else is rejected by
 * validatePackManifest so packs cannot drift ahead of the real schema
 * (which is additionalProperties: false).
 */
const KNOWN_MANIFEST_FIELDS = new Set([
  'id', 'name', 'version', 'published_at', 'source_class',
  'supersedes', 'index', 'signature', 'embedding', 'chunking', 'docs',
]);

/** Lowercase a course title into a pack-id slug piece ('' when empty). */
export function slugifyPackId(course: string): string {
  const slug = course
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug;
}

/**
 * Default pack id: course-title slug + the publisher's stable course id from
 * meta.xml (e.g. 'opmed-cdp-microlearning-companion-mlc-5fox24eqh9w'). The
 * courseid piece makes the id collision-safe across same-titled courses while
 * staying stable across re-publishes. Returns undefined when either piece is
 * missing — the caller must fail loud rather than silently collide.
 */
export function defaultPackId(course: string, courseid: string | undefined): string | undefined {
  const slug = slugifyPackId(course);
  const cid = courseid?.toLowerCase() ?? '';
  if (slug.length === 0 || cid.length === 0) return undefined;
  const id = `${slug}-${cid}`;
  return PACK_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Phase 4.2 guardrail: the ONE path-safety gate for pack-internal doc paths.
 * Rejects absolute paths, backslashes, '..'/'.' segments, and empty values so
 * an adversarial manifest can never escape the pack root (compose refuses to
 * emit such a path; verify refuses to honor one).
 */
export function assertSafeDocPath(value: string): void {
  if (value.length === 0) throw new Error('doc path must not be empty');
  if (value.includes('\\')) throw new Error(`doc path must use forward slashes (refused): ${JSON.stringify(value)}`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`doc path must be relative (refused): ${JSON.stringify(value)}`);
  }
  for (const segment of value.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new Error(`doc path contains a relative-path segment (refused): ${JSON.stringify(value)}`);
    }
    if (segment.includes('\u0000')) {
      throw new Error(`doc path contains a NUL byte (refused): ${JSON.stringify(value)}`);
    }
  }
}

export interface ManifestProblems {
  ok: boolean;
  problems: string[];
}

/** Structural validation of a parsed pack.json against the #68 draft shape. */
export function validatePackManifest(value: unknown): ManifestProblems {
  const problems: string[] = [];
  const add = (message: string): void => {
    problems.push(message);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: ['pack.json must be a JSON object'] };
  }
  const manifest = value as Record<string, unknown>;

  for (const key of Object.keys(manifest)) {
    if (!KNOWN_MANIFEST_FIELDS.has(key)) {
      add(`unknown field "${key}" (the draft #68 manifest allows only: ${[...KNOWN_MANIFEST_FIELDS].join(', ')})`);
    }
  }

  if (typeof manifest['id'] !== 'string' || !PACK_ID_PATTERN.test(manifest['id'] as string)) {
    add('id is missing or does not match ^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$');
  }
  if (typeof manifest['name'] !== 'string' || (manifest['name'] as string).length === 0) {
    add('name is missing or empty');
  }
  if (typeof manifest['version'] !== 'string' || !SEMVER_PATTERN.test(manifest['version'] as string)) {
    add('version is missing or not semver 2.0.0');
  }
  if (typeof manifest['published_at'] !== 'string' || (manifest['published_at'] as string).length === 0) {
    add('published_at is missing or empty');
  }
  const sourceClass = manifest['source_class'];
  if (
    typeof sourceClass !== 'string' ||
    !['bundled', 'training', 'user'].includes(sourceClass)
  ) {
    add('source_class must be one of bundled|training|user');
  }

  const embedding = manifest['embedding'];
  if (typeof embedding !== 'object' || embedding === null) {
    add('embedding block is missing');
  } else {
    const emb = embedding as Record<string, unknown>;
    if (typeof emb['model_id'] !== 'string' || (emb['model_id'] as string).length === 0) {
      add('embedding.model_id is missing or empty');
    }
    if (typeof emb['dims'] !== 'number' || !Number.isInteger(emb['dims']) || (emb['dims'] as number) < 1) {
      add('embedding.dims must be a positive integer');
    }
    if (typeof emb['normalize'] !== 'boolean') {
      add('embedding.normalize must be a boolean');
    }
  }

  const chunking = manifest['chunking'];
  if (typeof chunking !== 'object' || chunking === null) {
    add('chunking block is missing');
  } else {
    const chunk = chunking as Record<string, unknown>;
    if (
      typeof chunk['strategy'] !== 'string' ||
      !(CHUNKING_STRATEGIES as readonly string[]).includes(chunk['strategy'])
    ) {
      add(`chunking.strategy must be one of ${CHUNKING_STRATEGIES.join('|')}`);
    }
    if (typeof chunk['size'] !== 'number' || (chunk['size'] as number) < 1) {
      add('chunking.size must be a positive integer');
    }
    if (typeof chunk['overlap'] !== 'number' || (chunk['overlap'] as number) < 0) {
      add('chunking.overlap must be a non-negative integer');
    }
  }

  const docs = manifest['docs'];
  if (!Array.isArray(docs) || docs.length === 0) {
    add('docs[] is missing or empty');
  } else {
    docs.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        add(`docs[${i}] must be an object`);
        return;
      }
      const doc = entry as Record<string, unknown>;
      if (typeof doc['path'] !== 'string' || (doc['path'] as string).length === 0) {
        add(`docs[${i}].path is missing or empty`);
      } else {
        try {
          assertSafeDocPath(doc['path'] as string);
        } catch (error) {
          add(`docs[${i}].path refused: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (typeof doc['sha256'] !== 'string' || !SHA256_PATTERN.test(doc['sha256'] as string)) {
        add(`docs[${i}].sha256 must be 64 lowercase hex chars`);
      }
      if (typeof doc['title'] !== 'string' || (doc['title'] as string).length === 0) {
        add(`docs[${i}].title is missing or empty`);
      }
      if (typeof doc['mime'] !== 'string' || (doc['mime'] as string).length === 0) {
        add(`docs[${i}].mime is missing or empty`);
      }
    });
  }

  const index = manifest['index'];
  if (index !== undefined && index !== null) {
    if (typeof index !== 'object') {
      add('index block must be an object');
    } else {
      const idx = index as Record<string, unknown>;
      if (typeof idx['path'] !== 'string' || (idx['path'] as string).length === 0) {
        add('index.path is missing or empty');
      } else {
        // Final-critic round 1: index.path is manifest-supplied and would
        // otherwise reach verify's filesystem join unguarded (traversal).
        try {
          assertSafeDocPath(idx['path'] as string);
        } catch (error) {
          add(`index.path refused: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (typeof idx['schema_version'] !== 'number' || (idx['schema_version'] as number) < 1) {
        add('index.schema_version must be a positive integer');
      }
      if (typeof idx['sqlite_vec_version'] !== 'string' || (idx['sqlite_vec_version'] as string).length === 0) {
        add('index.sqlite_vec_version is missing or empty');
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
