// b6-ingest-pipeline.test.ts — B6 ingest contract checks (issue #64, C1/AC1).
//
// Drives the REAL production path — NodeBackendHost.start() with a configured
// store and the deterministic hash embedder (env TRAININGAPP_DESKTOP_EMBEDDER
// =hash: no model weights, no network) — over raw loopback HTTP, pinning the
// ingest contract behavior the StubEngine cannot satisfy:
//   - POST /ingest counts only SUPPORTED files and reports them honestly;
//   - content dedupe by sha256 (same bytes again — even under a different
//     filename — is a no-op success with documents:0);
//   - GET /documents lists documents by their SOURCE PATH (frozen
//     DocumentInfo.id contract in contracts/api.openapi.yaml);
//   - multipart /ingest/file ("file" part) and /ingest/batch ("files" parts)
//     persist uploads and answer the frozen response shapes;
//   - the route-level negatives: a multipart POST missing its file part and a
//     batch over the 20-file cap each answer the contract 400.
//
// RED AT BASE: this file statically imports
// desktop/main/backend/ingest/extractors.js, which does not exist until #64
// lands — the whole file fails collection with a module-not-found error, which
// IS the acceptance evidence for the missing ingest wiring. Unlike the b5
// suite (dynamic imports + graceful skip) there is nothing to exercise without
// the new modules, so desktop/node_modules is simply required (CI has it).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeBackendHost } from '../../main/backend/index.js';
import { SUPPORTED_EXTENSIONS } from '../../main/backend/ingest/extractors.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'b6-test-token';

/** Repo-root discovery via the established contracts marker (b4/b5 convention). */
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

/** Temp dirs created by the current test; removed in afterEach. */
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

/** Deterministic filler: n short unique words joined by single spaces. */
function words(n: number, prefix = 'w'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

/** Minimal raw-HTTP JSON client: no retries, bounded by a socket timeout. */
function httpJson(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { 'x-desktop-token': token, ...extraHeaders };
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

/** RFC 7578 multipart/form-data body with one part per file (hand-built). */
function multipart(
  parts: Array<{ name: string; filename: string; data: Buffer }>,
  boundary = 'b6ac7351a5boundary',
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
        'utf8',
      ),
    );
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Start a host with the deterministic hash embedder; stop() in finally. */
async function withHost<T>(storePath: string, run: (port: number) => Promise<T>): Promise<T> {
  const host = new NodeBackendHost({
    token: TOKEN,
    storePath,
    storeEmbeddingDims: 8,
    env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
  });
  const handle = await host.start();
  try {
    return await run(handle.port);
  } finally {
    await host.stop();
  }
}

describe('b6 C1 (AC1): ingest + list over the guarded HTTP contract', () => {
  itReal('POST /ingest ingests supported files once; GET /documents lists them by source path', async () => {
    const root = makeTempDir('b6-c1-dir-');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'a.txt'), words(600, 'alpha'), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'b.md'), words(40, 'beta'), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'c.txt'), words(30, 'gamma'), 'utf8');

    await withHost(path.join(root, 'store', 'store.sqlite'), async (port) => {
      const first = await httpJson(port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(first.status).toBe(200);
      expect(first.json?.success).toBe(true);
      expect(first.json?.documents).toBe(3);
      expect(first.json?.chunks_added as number).toBeGreaterThanOrEqual(3);

      // Frozen contract: DocumentInfo.id is the document SOURCE PATH.
      const listed = await httpJson(port, 'GET', '/documents', undefined, TOKEN);
      expect(listed.status).toBe(200);
      expect(listed.json?.total).toBe(3);
      const documents = listed.json?.documents as Array<{ id: string; chunk_count: number }>;
      expect(documents.map((doc) => doc.id).sort()).toEqual(
        [path.join(docsDir, 'a.txt'), path.join(docsDir, 'b.md'), path.join(docsDir, 'c.txt')].sort(),
      );
      for (const doc of documents) expect(doc.chunk_count).toBeGreaterThan(0);

      // Content dedupe: same directory again is a no-op success.
      const second = await httpJson(port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(second.status).toBe(200);
      expect(second.json?.success).toBe(true);
      expect(second.json?.documents).toBe(0);
      expect(second.json?.chunks_added).toBe(0);

      // Same BYTES under a DIFFERENT filename never adds a document (sha256
      // identity, never path): dedupe fires before any path replacement.
      fs.copyFileSync(path.join(docsDir, 'a.txt'), path.join(docsDir, 'a-copy.txt'));
      const third = await httpJson(port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(third.status).toBe(200);
      expect(third.json?.success).toBe(true);
      expect(third.json?.documents).toBe(0);
      const afterCopy = await httpJson(port, 'GET', '/documents', undefined, TOKEN);
      expect(afterCopy.json?.total).toBe(3);
    });
  });

  itReal('multipart /ingest/file and /ingest/batch persist uploads and match the response shapes', async () => {
    const root = makeTempDir('b6-c1-mp-');
    await withHost(path.join(root, 'store', 'store.sqlite'), async (port) => {
      const single = multipart([{ name: 'file', filename: 'hello.txt', data: Buffer.from(words(80, 'hello'), 'utf8') }]);
      const one = await httpJson(port, 'POST', '/ingest/file', single.body, TOKEN, {
        'content-type': single.contentType,
      });
      expect(one.status).toBe(200);
      expect(one.json?.success).toBe(true);
      expect(one.json?.documents).toBe(1);
      expect(one.json?.chunks_added as number).toBeGreaterThanOrEqual(1);
      expect((await httpJson(port, 'GET', '/documents', undefined, TOKEN)).json?.total).toBe(1);

      // Two files (the contract cap of 20 is route-level 400 behavior, out of
      // scope here; what is pinned is the frozen BatchIngestResponse shape).
      const batch = multipart([
        { name: 'files', filename: 'one.txt', data: Buffer.from(words(50, 'one'), 'utf8') },
        { name: 'files', filename: 'two.txt', data: Buffer.from(words(50, 'two'), 'utf8') },
      ]);
      const many = await httpJson(port, 'POST', '/ingest/batch', batch.body, TOKEN, {
        'content-type': batch.contentType,
      });
      expect(many.status).toBe(200);
      expect(many.json?.total_files).toBe(2);
      expect(many.json?.successful).toBe(2);
      expect(many.json?.failed).toBe(0);
      expect(Array.isArray(many.json?.results)).toBe(true);
      const results = many.json?.results as Array<{ filename: string; success: boolean }>;
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(typeof result.filename).toBe('string');
        expect(result.success).toBe(true);
      }
      expect((await httpJson(port, 'GET', '/documents', undefined, TOKEN)).json?.total).toBe(3);
    });
  });

  itReal('directory ingest skips unsupported extensions (only supported files counted)', async () => {
    // Module-level pin backing the skip behavior: .xyz is not a supported format.
    expect(SUPPORTED_EXTENSIONS).not.toContain('.xyz');
    const root = makeTempDir('b6-c1-unsup-');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'notes.txt'), words(60, 'note'), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'data.xyz'), 'not a supported format', 'utf8');
    await withHost(path.join(root, 'store', 'store.sqlite'), async (port) => {
      const res = await httpJson(port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.json?.success).toBe(true);
      expect(res.json?.documents).toBe(1);
      expect(res.json?.chunks_added as number).toBeGreaterThanOrEqual(1);
      const listed = await httpJson(port, 'GET', '/documents', undefined, TOKEN);
      expect(listed.json?.total).toBe(1);
      expect((listed.json?.documents as Array<{ id: string }>)[0].id).toBe(path.join(docsDir, 'notes.txt'));
    });
  });
});

describe('b6 C1 negatives (critic R2)', () => {
  itReal('POST /ingest/file with no file part answers the contract 400', async () => {
    const root = makeTempDir('b6-c1-nofile-');
    await withHost(path.join(root, 'store', 'store.sqlite'), async (port) => {
      // A well-formed multipart body that simply carries no `file` part must
      // be rejected at the route (400), never forwarded to the pipeline as an
      // empty ingest that would masquerade as success.
      const res = await httpJson(port, 'POST', '/ingest/file', Buffer.from('--x--\r\n', 'utf8'), TOKEN, {
        'content-type': 'multipart/form-data; boundary=x',
      });
      expect(res.status).toBe(400);
    });
  });

  itReal('POST /ingest/batch with more than 20 files answers the contract 400', async () => {
    const root = makeTempDir('b6-c1-cap-');
    await withHost(path.join(root, 'store', 'store.sqlite'), async (port) => {
      // 21 perfectly valid parts: the contract cap (20) must fire at the route
      // BEFORE any store write, so the corpus stays empty despite the overshoot.
      const over = multipart(
        Array.from({ length: 21 }, (_, i) => ({
          name: 'files',
          filename: `f${i}.txt`,
          data: Buffer.from(words(10, `f${i}`), 'utf8'),
        })),
      );
      const res = await httpJson(port, 'POST', '/ingest/batch', over.body, TOKEN, {
        'content-type': over.contentType,
      });
      expect(res.status).toBe(400);
      expect((await httpJson(port, 'GET', '/documents', undefined, TOKEN)).json?.total).toBe(0);
    });
  });
});
