// build/compose.ts — packtool build-storyline orchestrator (issue #79, D3).
//
// Composes D1's extracted slide documents + D2's cached transcripts + the raw
// publish folder into one installable training pack:
//   <staging>/pack.json          — manifest (source_class "training", #68 draft shape)
//   <staging>/docs/*.json        — slide docs (extract bytes) + the pack outline doc
//   <staging>/index.sqlite       — prebuilt embeddings + FTS5 (store.schema.sql v1)
//   <staging>/assets/player/...  — html5/, story.html, story_content/ byte-for-byte
// then zips the staging tree (pack.json as the first entry).
//
// Determinism: JSON serialization has fixed key order; doc order is spine
// order (outline doc last); doc ids/chunk ids are content hashes; zip entries
// carry fixed dates derived from --published-at (epoch otherwise) and are
// added in sorted order with fixed compression. published_at (defaulting to
// build time) is the one volatile field.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { chunkIdFor, chunkSlideText, contentHashFor, docIdFor, normalizedText } from './chunk.js';
import { resolveBuildEmbedder } from './embedder.js';
import { findRepoRoot, writePackIndex } from './index-writer.js';
import {
  DOC_MIME,
  INDEX_FILE_NAME,
  OUTLINE_DOC_PATH,
  PACK_JSON_NAME,
  PLAYER_ASSETS_PREFIX,
  SOURCE_CLASS_TRAINING,
  SQLITE_VEC_PIN,
  STORE_SCHEMA_VERSION,
  defaultPackId,
  serializePackJson,
  serializePackOutlineDoc,
  type PackDocEntry,
  type PackManifest,
  type PackOutlineDoc,
} from './pack-json.js';
import { readMetaAuthor, readMetaProjectAttribute } from '../storyline/spine.js';
import type { OutlineDoc, SlideDoc } from '../storyline/types.js';
import { extractPublishDir } from '../storyline/extract.js';

export interface BuildStorylineOptions {
  publishDir: string;
  /** Output zip path (--out). */
  out: string;
  /** D2 ASR transcript store (--asr-dir), passed through to the extractor. */
  asrDir?: string;
  embedder?: 'hash' | 'onnx';
  modelDir?: string;
  id?: string;
  version?: string;
  name?: string;
  publishedAt?: string;
  /** Repository root (contracts/, models/); auto-discovered by default. */
  repoRoot?: string;
}

export interface BuildStorylineResult {
  packPath: string;
  packId: string;
  docs: number;
  chunks: number;
  bytes: number;
}

interface DocBuild {
  entry: PackDocEntry;
  docId: string;
  chunkText: string;
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const SLIDE_FILE_PATTERN = /^slide-\d+-(.+)\.json$/;

/** The RAG text a slide contributes: title line, on-screen text, transcript. */
function slideChunkText(doc: SlideDoc): string {
  return [doc.slide_title, doc.on_screen_text, doc.transcript_text]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** The RAG text the course-outline document contributes. */
function outlineChunkText(outline: PackOutlineDoc): string {
  const lines = [
    outline.title,
    `Duration: ${outline.duration}`,
    ...(outline.author !== undefined ? [`Author: ${outline.author}`] : []),
    'Course outline:',
    ...outline.sections.map((s) => `- ${s.title} (${s.slide_count} slides)`),
  ];
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

export async function buildStorylinePack(options: BuildStorylineOptions): Promise<BuildStorylineResult> {
  const publishDir = path.resolve(options.publishDir);
  if (!existsSync(publishDir)) {
    throw new Error(`publishDir does not exist: ${options.publishDir}`);
  }
  const outPath = path.resolve(options.out);
  // A failed build must not leave a stale pack from a previous run at --out
  // (PR review RB-2): remove it up front so failure = no artifact.
  if (existsSync(outPath)) {
    rmSync(outPath, { force: true });
  }
  const repoRoot = options.repoRoot ?? findRepoRoot(moduleDir());
  if (repoRoot === undefined) {
    throw new Error(`cannot locate ${SCHEMA_HINT} above ${moduleDir()}`);
  }

  const embedderKind = options.embedder ?? 'onnx';
  const embedder = resolveBuildEmbedder({
    embedder: embedderKind,
    modelDir: options.modelDir,
    repoRoot,
  });

  const version = options.version ?? '1.0.0';
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const scratch = mkdtempSync(path.join(tmpdir(), 'packtool-build-'));
  try {
    // 1. D1 extraction (fresh dir — extract refuses to clobber foreign files).
    const extractDir = path.join(scratch, 'extract');
    mkdirSync(extractDir, { recursive: true });
    extractPublishDir(publishDir, extractDir, { asrDir: options.asrDir });
    const slideNames = readdirSync(path.join(extractDir, 'slides')).sort().filter((n) => n.endsWith('.json'));
    if (slideNames.length === 0) {
      throw new Error(`no content slides extracted from ${publishDir}`);
    }
    const extractOutline = JSON.parse(
      readFileSync(path.join(extractDir, 'outline.json'), 'utf8'),
    ) as OutlineDoc;

    // 2. Course identity from meta.xml (publisher-carried, stable).
    const metaXml = readFileSync(path.join(publishDir, 'meta.xml'), 'utf8');
    const author = readMetaAuthor(metaXml);
    const courseid = readMetaProjectAttribute(metaXml, 'courseid');
    const packId = options.id ?? defaultPackId(extractOutline.course, courseid);
    if (packId === undefined) {
      throw new Error(
        'cannot derive a pack id: meta.xml carries neither courseid nor a slugifiable course title; pass --id',
      );
    }
    const packName = options.name ?? extractOutline.course;

    // 3. Stage the pack tree: docs/ (slide files byte-for-byte + the pack
    // outline document) and assets/player/ (the enumerated publish entries).
    const staging = path.join(scratch, 'pack');
    const docsDir = path.join(staging, 'docs');
    const playerDir = path.join(staging, PLAYER_ASSETS_PREFIX);
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(playerDir, { recursive: true });

    const docBuilds: DocBuild[] = [];
    for (const name of slideNames) {
      const bytes = readFileSync(path.join(extractDir, 'slides', name));
      const docId = docIdFor(bytes);
      const slide = JSON.parse(bytes.toString('utf8')) as SlideDoc;
      writeFileSync(path.join(docsDir, name), bytes);
      docBuilds.push({
        entry: {
          path: `docs/${name}`,
          sha256: docId,
          title: slide.slide_title || slide.provenance || slide.slide_id,
          mime: DOC_MIME,
        },
        docId,
        chunkText: slideChunkText(slide),
      });
    }

    // The pack outline document — a build-storyline product (NOT D1's file;
    // D1's OutlineDoc type and extract output stay untouched).
    const packOutline: PackOutlineDoc = {
      title: extractOutline.course,
      course: extractOutline.course,
      duration: extractOutline.duration,
      ...(author !== undefined ? { author } : {}),
      scene_count: extractOutline.scene_count,
      sections: extractOutline.sections,
    };
    const outlineBytes = Buffer.from(serializePackOutlineDoc(packOutline), 'utf8');
    const outlineDocId = docIdFor(outlineBytes);
    writeFileSync(path.join(staging, OUTLINE_DOC_PATH), outlineBytes);
    docBuilds.push({
      entry: { path: OUTLINE_DOC_PATH, sha256: outlineDocId, title: packOutline.title, mime: DOC_MIME },
      docId: outlineDocId,
      chunkText: outlineChunkText(packOutline),
    });

    // 4. Player assets — byte-for-byte (the issue's enumerated set). Copied
    // through a link-refusing walk, never fs.cpSync: cpSync dereferences
    // Windows junctions/directory symlinks (even with dereference:false —
    // the native fast path recurses into reparse points), so a poisoned
    // publish folder could silently bundle arbitrary outside files into the
    // distributable pack (PR review F2-1, empirically confirmed).
    for (const entryName of ['html5', 'story.html', 'story_content']) {
      const source = path.join(publishDir, entryName);
      if (!existsSync(source)) {
        throw new Error(`publish folder is missing the required player asset: ${entryName}`);
      }
      copyTreeRejectingLinks(source, path.join(playerDir, entryName));
    }

    // 5. Chunk + embed per document (chunks never cross documents; zero-text
    // documents contribute zero chunks and no embed call).
    const docRows = docBuilds.map((build) => ({
      docId: build.docId,
      path: build.entry.path,
      sha256: build.entry.sha256,
      title: build.entry.title,
      publishedAt,
    }));
    const chunkRows: Array<{
      chunkId: string;
      docId: string;
      chunkIndex: number;
      text: string;
      contentHash: string;
      vector: number[];
    }> = [];
    for (const build of docBuilds) {
      const chunks = chunkSlideText(build.chunkText);
      const texts = chunks.map((chunk) => chunk.text);
      const vectors = texts.length > 0 ? await embedder.embed(texts) : [];
      chunks.forEach((chunk, i) => {
        const normalized = normalizedText(chunk.text);
        const vector = vectors[i];
        if (vector === undefined) throw new Error(`embedder returned no vector for a chunk of ${build.entry.path}`);
        chunkRows.push({
          chunkId: chunkIdFor(build.docId, chunk.chunkIndex, normalized),
          docId: build.docId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          contentHash: contentHashFor(normalized),
          vector,
        });
      });
    }

    const manifest: PackManifest = {
      id: packId,
      name: packName,
      version,
      published_at: publishedAt,
      source_class: SOURCE_CLASS_TRAINING,
      embedding: { model_id: embedder.modelId, dims: embedder.dims, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
      docs: docBuilds.map((build) => build.entry),
      index: { path: INDEX_FILE_NAME, schema_version: STORE_SCHEMA_VERSION, sqlite_vec_version: SQLITE_VEC_PIN },
    };

    // 6. Prebuilt index (schema applied from contracts/store.schema.sql).
    writePackIndex({
      dbPath: path.join(staging, INDEX_FILE_NAME),
      repoRoot,
      dims: embedder.dims,
      manifest,
      docs: docRows,
      chunks: chunkRows,
    });

    // 7. Zip: pack.json first, then every directory entry, then the files —
    // all with the fixed date. JSZip auto-creates parent folders with the
    // CURRENT time when createFolders is left on, which is the one thing
    // that would make two builds of identical input differ byte-wise.
    const zip = new JSZip();
    const zipDate = new Date(publishedAt);
    const entryPaths = listFilesRelative(staging);
    const dirEntries = new Set<string>();
    for (const rel of entryPaths) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        dirEntries.add(`${parts.slice(0, i).join('/')}/`);
      }
    }
    for (const dir of [...dirEntries].sort((x, y) => x.localeCompare(y))) {
      zip.file(dir, null, { date: zipDate, createFolders: false, dir: true });
    }
    zip.file(PACK_JSON_NAME, serializePackJson(manifest), { date: zipDate, createFolders: false });
    const entryPathsSorted = entryPaths.sort((a, b) => a.localeCompare(b));
    for (const rel of entryPathsSorted) {
      zip.file(rel, readFileSync(path.join(staging, rel)), { date: zipDate, createFolders: false });
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    // Atomic publish (PR review C3): write to a sibling temp file and rename
    // over --out, so a crash mid-write can never leave a torn zip at the
    // user-visible path.
    const tempOut = `${outPath}.tmp-${process.pid}`;
    writeFileSync(tempOut, buffer);
    renameSync(tempOut, outPath);

    return {
      packPath: outPath,
      packId,
      docs: docBuilds.length,
      chunks: chunkRows.length,
      bytes: buffer.length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const SCHEMA_HINT = 'contracts/store.schema.sql';

function listFilesRelative(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(root, full));
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Recursive copy that REFUSES symlinks and Windows junctions instead of
 * dereferencing them: every entry is lstat-checked, so a poisoned publish
 * folder cannot pull files from outside its root into the pack (PR review
 * F2-1; fs.cpSync dereferences junctions on Windows even with
 * dereference:false).
 */
function copyTreeRejectingLinks(src: string, dest: string): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symlink/junction in publish folder: ${src}`);
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copyTreeRejectingLinks(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else if (stat.isFile()) {
    copyFileSync(src, dest);
  } else {
    throw new Error(`refusing non-regular publish entry: ${src}`);
  }
}
