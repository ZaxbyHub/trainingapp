// b6-profile-progress.test.ts — B6 profile model, ingest config, progress
// events, restart persistence, and the ported chunker/extractor pins
// (issue #64, C4; AC2 config keys, AC3 persistence, plus the text-chunker
// behavior pins 5a-5f and the extractor surface).
//
// Covers:
//   - resolveProfileLayout: default single profile, named profiles via
//     TRAININGAPP_PROFILE_MODE/NAME, strict [a-z0-9-]{1,64} name allowlist;
//   - migrateLegacyStoreLayout: one-time <u>/store/store.db move, idempotent,
//     never clobbers an existing target;
//   - resolveIngestConfig: pinned defaults, per-key env overrides, per-key
//     fallback on invalid values, and the overlap>=words PAIR fallback;
//   - onIngestProgress: well-formed, per-docId monotonic events via the host;
//   - restart persistence: the corpus survives host stop()/start() cycles;
//   - TextChunker / extractors: the Python-ported chunking pins.
//
// RED AT BASE: statically imports the not-yet-existing ingest/ and
// store/profiles.js modules — the intended failing-first state. Requires
// desktop/node_modules (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeBackendHost } from '../../main/backend/index.js';
import { DEFAULT_INGEST_CONFIG, resolveIngestConfig } from '../../main/backend/ingest/config.js';
import { extractDocumentFromFile, SUPPORTED_EXTENSIONS } from '../../main/backend/ingest/extractors.js';
import { TextChunker } from '../../main/backend/ingest/text-chunker.js';
import { migrateLegacyStoreLayout, resolveProfileLayout } from '../../main/backend/store/profiles.js';
import { openStore } from '../../main/backend/store/sqlite-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'b6-test-token';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function words(n: number, prefix = 'w'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function httpJson(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { 'x-desktop-token': token };
    if (isJson) headers['content-type'] = 'application/json';
    if (payload !== undefined) headers['content-length'] = String(payload.length);
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown>, text });
        } catch {
          resolve({ status: res.statusCode ?? 0, text });
        }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error(`httpJson ${method} ${requestPath} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function hashEmbedderEnv(): Record<string, string> {
  return { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' };
}

describe('b6 C4: profile layout model', () => {
  // resolveProfileLayout is pure path resolution — no disk access, so the
  // userData path below deliberately does not exist.
  const fakeUserData = path.join(os.tmpdir(), 'b6-userdata-unused');

  it('resolves the default single profile under <userData>/profiles/default', () => {
    expect(resolveProfileLayout({ userDataPath: fakeUserData })).toEqual({
      mode: 'single',
      profileName: 'default',
      storePath: path.join(fakeUserData, 'profiles', 'default', 'store.sqlite'),
    });
  });

  it('resolves named profiles from TRAININGAPP_PROFILE_MODE/NAME (64-char names allowed)', () => {
    const longName = 'a'.repeat(64);
    expect(
      resolveProfileLayout({
        userDataPath: fakeUserData,
        env: { TRAININGAPP_PROFILE_MODE: 'named', TRAININGAPP_PROFILE_NAME: 'team-x' },
      }),
    ).toEqual({
      mode: 'named',
      profileName: 'team-x',
      storePath: path.join(fakeUserData, 'profiles', 'team-x', 'store.sqlite'),
    });
    const long = resolveProfileLayout({
      userDataPath: fakeUserData,
      env: { TRAININGAPP_PROFILE_MODE: 'named', TRAININGAPP_PROFILE_NAME: longName },
    });
    expect(long.profileName).toBe(longName);
  });

  it('rejects malformed profile names and mode values loudly', () => {
    for (const name of ['Team', 'a/b', 'a\\b', '..', '', 'x'.repeat(65)]) {
      expect(() =>
        resolveProfileLayout({
          userDataPath: fakeUserData,
          env: { TRAININGAPP_PROFILE_MODE: 'named', TRAININGAPP_PROFILE_NAME: name },
        }),
      ).toThrow();
    }
    // named mode without a name never silently falls back to default.
    expect(() => resolveProfileLayout({ userDataPath: fakeUserData, env: { TRAININGAPP_PROFILE_MODE: 'named' } })).toThrow();
    expect(() => resolveProfileLayout({ userDataPath: fakeUserData, env: { TRAININGAPP_PROFILE_MODE: 'bogus' } })).toThrow();
  });
});

describe('b6 C4: legacy store migration', () => {
  itReal('moves <u>/store/store.db to profiles/default once, keeping the DB usable', () => {
    const userData = makeTempDir('b6-legacy-');
    const legacy = path.join(userData, 'store', 'store.db');
    openStore({ dbPath: legacy, dims: 8, repoRoot: REPO_ROOT }).close();

    expect(migrateLegacyStoreLayout(userData)).toBe(true);
    const target = path.join(userData, 'profiles', 'default', 'store.sqlite');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    const reopened = openStore({ dbPath: target, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(reopened.schemaVersion).toBe(1);
    } finally {
      reopened.close();
    }
    // Idempotent: nothing left to move.
    expect(migrateLegacyStoreLayout(userData)).toBe(false);
  });

  itReal('never clobbers when both legacy and target already exist', () => {
    const userData = makeTempDir('b6-legacy2-');
    const legacy = path.join(userData, 'store', 'store.db');
    openStore({ dbPath: legacy, dims: 8, repoRoot: REPO_ROOT }).close();
    const target = path.join(userData, 'profiles', 'default', 'store.sqlite');
    openStore({ dbPath: target, dims: 8, repoRoot: REPO_ROOT }).close();
    const targetHash = sha256File(target);

    expect(migrateLegacyStoreLayout(userData)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(sha256File(target)).toBe(targetHash);
  });
});

describe('b6 C4 (AC2): ingest config resolution', () => {
  const DEFAULTS = { maxConcurrentFiles: 2, chunkWordCount: 256, chunkOverlapWords: 100 };

  it('returns the pinned defaults when env is absent', () => {
    expect(DEFAULT_INGEST_CONFIG).toEqual(DEFAULTS);
    expect(resolveIngestConfig()).toEqual(DEFAULTS);
    expect(resolveIngestConfig({})).toEqual(DEFAULTS);
  });

  it('applies positive-integer env overrides per key', () => {
    expect(
      resolveIngestConfig({
        TRAININGAPP_INGEST_MAX_CONCURRENT_FILES: '5',
        TRAININGAPP_INGEST_CHUNK_WORD_COUNT: '128',
        TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS: '64',
      }),
    ).toEqual({ maxConcurrentFiles: 5, chunkWordCount: 128, chunkOverlapWords: 64 });
  });

  it('falls back per key on invalid values (non-numeric, 0, negative, fractional)', () => {
    for (const bad of ['abc', '0', '-3', '2.5']) {
      expect(resolveIngestConfig({ TRAININGAPP_INGEST_MAX_CONCURRENT_FILES: bad })).toEqual(DEFAULTS);
    }
    expect(resolveIngestConfig({ TRAININGAPP_INGEST_CHUNK_WORD_COUNT: 'oops' })).toEqual(DEFAULTS);
    expect(resolveIngestConfig({ TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS: '-1' })).toEqual(DEFAULTS);
  });

  it('never yields overlap >= words: the PAIR falls back to both defaults', () => {
    expect(
      resolveIngestConfig({ TRAININGAPP_INGEST_CHUNK_WORD_COUNT: '150', TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS: '150' }),
    ).toEqual(DEFAULTS);
    // Cross-check with the defaults in play: an env word count below the
    // DEFAULT overlap (100) is still an invalid pair and must fall back whole.
    expect(resolveIngestConfig({ TRAININGAPP_INGEST_CHUNK_WORD_COUNT: '90' })).toEqual(DEFAULTS);
  });
});

describe('b6 C4 (AC3): progress events and restart persistence', () => {
  itReal('onIngestProgress receives well-formed, per-docId monotonic events', async () => {
    const root = makeTempDir('b6-prog-');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'p1.txt'), words(300, 'progone'), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'p2.txt'), words(200, 'progtwo'), 'utf8');

    const events: Array<{ docId: string; phase: string; percent: number }> = [];
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath: path.join(root, 'store.sqlite'),
      storeEmbeddingDims: 8,
      env: hashEmbedderEnv(),
      onIngestProgress: (event) => {
        events.push(event);
      },
    });
    const handle = await host.start();
    try {
      const res = await httpJson(handle.port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.json?.documents).toBe(2);
    } finally {
      await host.stop();
    }

    expect(events.length).toBeGreaterThan(0);
    const validPhases = new Set(['extract', 'chunk', 'embed', 'write', 'done']);
    const lastPercent = new Map<string, number>();
    for (const event of events) {
      expect(typeof event.docId).toBe('string');
      expect(event.docId.length).toBeGreaterThan(0);
      expect(validPhases.has(event.phase)).toBe(true);
      expect(typeof event.percent).toBe('number');
      expect(event.percent).toBeGreaterThanOrEqual(0);
      expect(event.percent).toBeLessThanOrEqual(100);
      const previous = lastPercent.get(event.docId);
      if (previous !== undefined) expect(event.percent).toBeGreaterThanOrEqual(previous);
      lastPercent.set(event.docId, event.percent);
    }
    const observedPhases = new Set(events.map((event) => event.phase));
    expect(observedPhases.has('extract')).toBe(true);
    expect(observedPhases.has('done')).toBe(true);
    // One progress stream per ingested document.
    expect(new Set(events.map((event) => event.docId)).size).toBe(2);
  });

  itReal('the corpus survives a host restart (same store path, fresh host instance)', async () => {
    const root = makeTempDir('b6-restart-');
    const storePath = path.join(root, 'store.sqlite');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'r1.txt'), words(120, 'rcone'), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'r2.txt'), words(120, 'rctwo'), 'utf8');

    const hostA = new NodeBackendHost({
      token: TOKEN,
      storePath,
      storeEmbeddingDims: 8,
      env: hashEmbedderEnv(),
    });
    const a = await hostA.start();
    try {
      const res = await httpJson(a.port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(res.json?.documents).toBe(2);
    } finally {
      await hostA.stop();
    }

    const hostB = new NodeBackendHost({
      token: TOKEN,
      storePath,
      storeEmbeddingDims: 8,
      env: hashEmbedderEnv(),
    });
    const b = await hostB.start();
    try {
      const listed = await httpJson(b.port, 'GET', '/documents', undefined, TOKEN);
      expect(listed.status).toBe(200);
      expect(listed.json?.total).toBe(2);
    } finally {
      await hostB.stop();
    }
  });
});

describe('b6 C4: TextChunker port pins (5a-5f)', () => {
  it('rejects invalid geometry: words<=0, overlap<0, overlap>=words', () => {
    expect(() => new TextChunker(0, 0)).toThrow();
    expect(() => new TextChunker(-10, 5)).toThrow();
    expect(() => new TextChunker(100, -1)).toThrow();
    expect(() => new TextChunker(256, 256)).toThrow();
    expect(() => new TextChunker(100, 200)).toThrow();
  });

  it('default 256/100 splits a 600-word document into ordered non-empty chunks', () => {
    const chunks = new TextChunker().chunkText(words(600, 'def'), 'def.txt');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it('CJK-dense text chunks by characters, not one giant word-chunk', () => {
    const cjk = '训练数据检索测试'.repeat(75); // 600 chars, zero whitespace
    const chunks = new TextChunker().chunkText(cjk, 'cjk.txt');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeGreaterThan(0);
  });

  it('terminates with overlap 1 on a long single sentence; every chunk non-empty', () => {
    const oneSentence = Array.from({ length: 600 }, (_, i) => `tok${i}`).join(' ');
    const chunks = new TextChunker(256, 1).chunkText(oneSentence, 'long.txt');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it('overlapping chunks share trailing/leading text', () => {
    const chunks = new TextChunker(40, 20).chunkText(words(120, 'ov'), 'ov.txt');
    expect(chunks.length).toBeGreaterThan(1);
    // With overlap 20 the second window starts INSIDE the first chunk's span.
    const lead = chunks[1].text.trim().split(/\s+/).slice(0, 3).join(' ');
    expect(lead.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain(lead);
  });

  it("sentence integrity: 'Dr. Smith' abbreviations are not split mid-sentence", () => {
    const chunks = new TextChunker(500, 100).chunkText('Dr. Smith arrived. He left.', 'dr.txt');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Dr. Smith arrived.');
    expect(chunks[0].text).toContain('He left.');
  });
});

describe('b6 C4: extractor surface', () => {
  it('SUPPORTED_EXTENSIONS covers the six pinned formats (md included)', () => {
    for (const ext of ['.pdf', '.docx', '.xlsx', '.txt', '.md', '.pptx']) {
      expect(SUPPORTED_EXTENSIONS).toContain(ext);
    }
  });

  it('extracts .md and .txt files as UTF-8 text', async () => {
    const dir = makeTempDir('b6-extract-');
    const mdPath = path.join(dir, 'note.md');
    fs.writeFileSync(mdPath, '# Title\n\nMD-EXTRACT-MARKER body text.\n', 'utf8');
    const md = await extractDocumentFromFile(mdPath);
    expect(md.text).toContain('MD-EXTRACT-MARKER');

    const txtPath = path.join(dir, 'note.txt');
    fs.writeFileSync(txtPath, 'TXT-EXTRACT-MARKER plain body.\n', 'utf8');
    const txt = await extractDocumentFromFile(txtPath);
    expect(txt.text).toContain('TXT-EXTRACT-MARKER');
  });

  it('rejects unsupported extensions', async () => {
    const dir = makeTempDir('b6-extract2-');
    const filePath = path.join(dir, 'blob.xyz');
    fs.writeFileSync(filePath, 'opaque bytes', 'utf8');
    await expect(extractDocumentFromFile(filePath)).rejects.toThrow();
  });
});
