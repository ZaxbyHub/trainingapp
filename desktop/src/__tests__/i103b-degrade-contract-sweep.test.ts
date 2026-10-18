// i103b-degrade-contract-sweep.test.ts — issue #167 (Cluster C of the
// test-batch-oct2026 trace): pin the load-bearing degrade-contract log lines
// the i103 sweep (PR #166, predicate P2) found asserted nowhere.
//
// NEW-SURFACE at base: before this file existed, deleting or rewording any
// line pinned below left every suite green — the behavior-side specs
// (b7-review-hardening, b6-corruption-recovery) prove the DEGRADED OUTCOME
// but never read the log, so the log text itself was an unexecuted contract.
// After this fix each line's exact text is executable; the 05-fix-plan
// named-mutation rows prove the kill:
//   AC5  delete index.ts        model-warmup-crashed   console.error -> warmup group
//   AC6  delete retrieval/hybrid.ts reranker-failed    console.error -> degrade group
//   AC7  delete index.ts        store-recovered        console.error -> lifecycle group
//   AC8  delete settings-store.ts not-a-JSON-object    console.error -> refusal group
//
// SELECTOR CONTRACT (frozen -t drivers): the four suite titles below carry
// the tokens warmup / degrade / lifecycle / refusal and those tokens appear
// in NO other GROUP title in this file (row titles inside a group may echo
// their group token), so
//   vitest run <this-file> -t <token>
// selects exactly one group. The tokens are file-scoped: the frozen i103
// C3/C4 drivers always pass their own file path, so this file never leaks
// into their `-t embedder` / `-t reranker` counts.
//
// STYLE: reuses i103-degrade-assertions.test.ts's console.error spy +
// substring pattern and its vi.doMock + vi.resetModules scoped-mock pattern
// (pack-manager / memory-telemetry), and b6/b7's real-store fixtures.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StubEngine } from '../../main/backend/engine.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { resolveIngestConfig } from '../../main/backend/ingest/config.js';
import { createRetrievalSurface, type RerankerSurface } from '../../main/backend/retrieval/hybrid.js';
import { assembleLearnResults } from '../../main/backend/learn.js';
import type { LinksDb } from '../../main/backend/store/links.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { createBackup } from '../../main/backend/store/backup.js';
import { StoreDocumentSurface } from '../../main/backend/store/document-surface.js';
import { settingsPathFor, loadSettingsSnapshot } from '../../main/backend/settings-store.js';
import { externalPathFor, loadExternalSnapshot, replayExternalSnapshot } from '../../main/backend/external-store.js';
import {
  resolvePacksSecurity,
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_PACKS_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
} from '../../main/backend/packs/pack-extract.js';
import type { CitedChunk } from '../../main/backend/types.js';
import { nativeDepsIt, NATIVE_DEPS_SKIP_MARKER, STAGING_INSTRUCTION } from './fixtures/native-deps-gate.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  let current = THIS_DIR;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
})();

// Real-store rows go through the shared D2 gate factory (issue #203): the
// native store addon must exist; missing deps FAIL under CI and SKIP locally
// with the staging instruction — never a silent skip. Ungated groups below
// import no native deps.
const itReal = nativeDepsIt('i103b-degrade-contract-sweep');

const TOKEN = 'i103b-contract-token';
const DIMS = 8;

const tempDirs: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Scoped doMocks (i103 pattern) must not leak into later tests' fresh
  // module graphs: unregister both before resetting the registry.
  vi.doUnmock('../../main/backend/store/pack-manager.js');
  vi.doUnmock('../../main/backend/memory/telemetry.js');
  vi.resetModules();
  while (hosts.length > 0) {
    const host = hosts.pop();
    if (host !== undefined) await host.stop().catch(() => {});
  }
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

function sha256hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** All first-arg strings a console.error spy has captured so far. */
function errorMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => String(args[0]));
}

/** Poll until the spy captured a first-arg line containing `substring`. */
async function waitForErrorLine(
  spy: { mock: { calls: unknown[][] } },
  substring: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = errorMessages(spy).find((m) => m.includes(substring));
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a console.error line containing "${substring}" (captured: ${JSON.stringify(errorMessages(spy))})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function getJson(
  port: number,
  requestPath: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    headers: { 'x-desktop-token': TOKEN },
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status ?? 0, json };
}

/** Seed one doc + chunk + fts row + embedding directly (interop insert rules). */
async function seedDoc(store: StoreHandle, docId: string, marker: string): Promise<void> {
  const chunkId = `${docId}-chunk0`;
  const text = `${marker} seeded chunk text for the i103b contract sweep.`;
  const vector = JSON.stringify((await new HashEmbedder({ dims: store.dims }).embed([text]))[0]);
  store.db
    .prepare("INSERT INTO docs (id, source_class, path, sha256, title) VALUES (?, 'general', ?, ?, ?)")
    .run(docId, `${docId}.txt`, sha256hex(text), docId);
  store.db
    .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, 0, ?, ?)')
    .run(chunkId, docId, text, sha256hex(text));
  store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunkId, text);
  store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vector);
}

// --------------------------------------------------------------------------
// Group 1: warmup. RED at base (no assertion referenced these lines, so
// deleting them passed every suite); GREEN after this fix pins both the
// index.ts warmup-crashed catch and the llama-engine warmup-failed catch.
// --------------------------------------------------------------------------
describe('i103b warmup contract sweep (#167)', () => {
  itReal(
    'a rejected engine warmup logs the warmup-crashed line and the host still starts',
    async () => {
      vi.resetModules(); // fresh graph, no scoped mocks — this contract is asserted independently
      const { NodeBackendHost } = await import('../../main/backend/index.js');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Injected-engine seam (types.ts BackendHostConfig.engine): StubEngine's
      // no-op warmup is shadowed by a rejecting own property, so the host's
      // `void this.engine.warmup?.().catch(...)` at index.ts:682 fires.
      const engine = Object.assign(new StubEngine(), {
        warmup: () => Promise.reject(new Error('injected warmup crash')),
      });
      const host = new NodeBackendHost({ token: TOKEN, engine, env: {} });
      hosts.push(host);
      const handle = await host.start();
      // Degraded outcome: the warmup failure never fails host start.
      expect(handle.mode).toBe('node');
      const line = await waitForErrorLine(errorSpy, '[trainingapp-backend] model warmup crashed: injected warmup crash');
      expect(line).toBe('[trainingapp-backend] model warmup crashed: injected warmup crash');
      // ...and the host keeps serving after the crash.
      const settings = await getJson(handle.port, '/settings');
      expect(settings.status).toBe(200);
      await host.stop();
    },
    60_000,
  );

  it(
    'an unloadable model logs the llama warmup-failed line (with the offending dir) and leaves the engine idle',
    async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dir = makeTempDir('i103b-warmup-llama-');
      // modelDir takes precedence over every env fallback (llama-engine.ts
      // resolveModelDir), so an empty temp dir is deterministic on machines
      // with staged weights: assertModelAvailable throws ModelNotConfiguredError.
      const engine = new LlamaEngine({ modelDir: path.join(dir, 'no-such-model-dir') });
      // The contract: warmup NEVER throws — the catch swallows the load failure.
      await expect(engine.warmup()).resolves.toBeUndefined();
      const line = await waitForErrorLine(
        errorSpy,
        '[trainingapp-backend] model warmup failed (the first /ask will retry the load): ',
      );
      // The dynamic suffix names the actual load failure (non-empty).
      expect(line, 'the pinned precondition is the unloadable model dir, not any warmup failure').toContain('no-such-model-dir');
    expect(line.length).toBeGreaterThan('[trainingapp-backend] model warmup failed (the first /ask will retry the load): '.length);
      // Degraded outcome: load state falls back to idle — the first /ask retries the load lazily.
      expect(engine.residentLoadStatus().state).toBe('idle');
    },
    30_000,
  );
});

// --------------------------------------------------------------------------
// Group 2: degrade. RED at base (b7 pins the BEHAVIOR of both catches but
// never the log line, so deleting the line passed every suite); GREEN after
// this fix pins the exact reranker-degrade and learn-omit lines plus the
// degraded outcomes (retrieval continues fused / learn omitted, not thrown).
// --------------------------------------------------------------------------
describe('i103b degrade contract sweep (#167)', () => {
  itReal(
    'a reranker throwing once logs the fused-ordering degrade line and retrieval keeps answering',
    async () => {
      const dir = makeTempDir('i103b-degrade-rerank-');
      const embedder = new HashEmbedder({ dims: DIMS });
      const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
      try {
        await seedDoc(store, 'doc-i103b', 'i103bzebra');
        const score = vi.fn(async (_query: string, _texts: string[]) => {
          throw new Error('injected reranker failure');
        });
        const broken: RerankerSurface = { score };
        const surface = createRetrievalSurface({ store, embedder, reranker: broken });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // First search: the reranker throws, the line fires, fused results return.
        const first = await surface.search('i103bzebra', 4);
        expect(first.length).toBeGreaterThanOrEqual(1);
        const line = await waitForErrorLine(
          errorSpy,
          '[trainingapp-backend] reranker failed once (degrading to fused ordering): injected reranker failure',
        );
        expect(line).toBe(
          '[trainingapp-backend] reranker failed once (degrading to fused ordering): injected reranker failure',
        );
        // Degraded outcome continues: the second query answers fused, the
        // latch keeps the broken reranker off, and the line fires exactly once.
        const second = await surface.search('i103bzebra', 4);
        expect(second.length).toBeGreaterThanOrEqual(1);
        expect(score).toHaveBeenCalledTimes(1);
        expect(errorMessages(errorSpy).filter((m) => m.includes('reranker failed once')).length).toBe(1);
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it('a failing learn assembly logs the learn-omitted line and learn is omitted, not thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Structural LinksDb (learn.ts declares the subset it needs): a store
    // whose prepare throws stands in for any mid-assembly store failure.
    const failingDb = {
      prepare: () => {
        throw new Error('injected learn store failure');
      },
    } as unknown as LinksDb;
    const cited: CitedChunk[] = [{ chunkId: 'c-i103b', score: 0.9 }];
    // The contract: never throws — the answer continues without learn.
    const result = assembleLearnResults({ db: failingDb, cited, packsRoot: null });
    expect(result).toBeNull();
    const line = await waitForErrorLine(
      errorSpy,
      '[trainingapp-backend] learn assembly failed (learn omitted): injected learn store failure',
    );
    expect(line).toBe('[trainingapp-backend] learn assembly failed (learn omitted): injected learn store failure');
  });
});

// --------------------------------------------------------------------------
// Group 3: lifecycle. RED at base (b6 pins the recovery BEHAVIOR, not the
// store-recovered line; the other three lines were asserted nowhere); GREEN
// after this fix pins each line plus the host-keeps-serving outcome.
// --------------------------------------------------------------------------
describe('i103b lifecycle contract sweep (#167)', () => {
  itReal(
    'a settings snapshot the engine refuses is logged and the host boots with defaults',
    async () => {
      vi.resetModules();
      const { NodeBackendHost } = await import('../../main/backend/index.js');
      const dir = makeTempDir('i103b-life-settings-');
      const storePath = path.join(dir, 'store.sqlite');
      // A key StubEngine's SETTING_BOUNDS refuses: the boot replay of the
      // persisted snapshot fails validation -> index.ts:547.
      fs.writeFileSync(settingsPathFor(storePath), JSON.stringify({ zz_unrecognized_setting: 7 }), 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const host = new NodeBackendHost({
        token: TOKEN,
        storePath,
        storeEmbeddingDims: DIMS,
        engine: new StubEngine(),
        env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      });
      hosts.push(host);
      const handle = await host.start();
      // Degraded outcome: rejection never fails host start; defaults boot.
      expect(handle.mode).toBe('node');
      const line = await waitForErrorLine(errorSpy, 'persisted settings snapshot rejected by the engine (');
      expect(line).toContain('); booting with defaults');
      // The refused patch was dropped: /settings answers engine defaults only.
      const settings = await getJson(handle.port, '/settings');
      expect(settings.status).toBe(200);
      expect(settings.json, 'a real settings body is required for the refused-patch check').not.toBeNull();
    expect(Object.keys(settings.json as Record<string, unknown>)).not.toContain('zz_unrecognized_setting');
      await host.stop();
    },
    60_000,
  );

  itReal(
    'a pack manager construction failure is logged and the host keeps serving',
    async () => {
      vi.resetModules();
      // Scoped mock (i103 reranker pattern): PackManager's constructor is
      // pure assignment (no natural throw), so the otherwise-unreachable
      // catch at index.ts:849 is exercised by injecting the throw.
      vi.doMock('../../main/backend/store/pack-manager.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../main/backend/store/pack-manager.js')>();
        return {
          ...actual,
          PackManager: class {
            constructor() {
              throw new Error('injected pack manager failure');
            }
          },
        };
      });
      const { NodeBackendHost } = await import('../../main/backend/index.js');
      const dir = makeTempDir('i103b-life-packs-');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const host = new NodeBackendHost({
        token: TOKEN,
        storePath: path.join(dir, 'store.sqlite'),
        storeEmbeddingDims: DIMS,
        engine: new StubEngine(),
        env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      });
      hosts.push(host);
      const handle = await host.start();
      // Degraded outcome: the pack failure never takes the host down.
      expect(handle.mode).toBe('node');
      const line = await waitForErrorLine(errorSpy, '[trainingapp-backend] pack lifecycle unavailable: injected pack manager failure');
      expect(line).toBe('[trainingapp-backend] pack lifecycle unavailable: injected pack manager failure');
      // ...and the document surface keeps serving without the pack lifecycle.
      const listed = await getJson(handle.port, '/documents');
      expect(listed.status).toBe(200);
      await host.stop();
    },
    60_000,
  );

  itReal(
    'a failing memory telemetry sample logs the memory-tick line and the sampler keeps ticking',
    async () => {
      vi.resetModules();
      // Scoped mock (i103 pattern): telemetry.sample() is the first throwing
      // seam inside memoryTick on a storeless host, so every tick rejects
      // into the index.ts:867 catch.
      vi.doMock('../../main/backend/memory/telemetry.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../main/backend/memory/telemetry.js')>();
        return {
          ...actual,
          createMemoryTelemetry: () => ({
            sample: () => {
              throw new Error('injected telemetry sample failure');
            },
            snapshot: () => {
              throw new Error('injected telemetry sample failure');
            },
          }),
        };
      });
      const { NodeBackendHost } = await import('../../main/backend/index.js');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const host = new NodeBackendHost({
        token: TOKEN,
        engine: new StubEngine(),
        env: { TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS: '25' },
      });
      hosts.push(host);
      const handle = await host.start();
      expect(handle.mode).toBe('node');
      const line = await waitForErrorLine(
        errorSpy,
        '[trainingapp-backend] memory tick failed (sampler continues): injected telemetry sample failure',
      );
      expect(line).toBe('[trainingapp-backend] memory tick failed (sampler continues): injected telemetry sample failure');
      // Degraded outcome: the sampler keeps firing — the failure is consumed
      // per tick and the interval survives (>= 2 lines over several ticks).
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        errorMessages(errorSpy).filter((m) => m.includes('[trainingapp-backend] memory tick failed (sampler continues)')).length,
      ).toBeGreaterThanOrEqual(2);
      // ...and the host still serves while the sampler runs broken.
      const settings = await getJson(handle.port, '/settings');
      expect(settings.status).toBe(200);
      await host.stop();
    },
    60_000,
  );

  itReal(
    'store corruption recovery logs the store-recovered line and the host serves the restored store',
    async () => {
      vi.resetModules();
      const { NodeBackendHost } = await import('../../main/backend/index.js');
      const dir = makeTempDir('i103b-life-recover-');
      const storePath = path.join(dir, 'store.sqlite');
      const backupsDir = path.join(dir, 'backups');
      const store = openStore({ dbPath: storePath, dims: DIMS, repoRoot: REPO_ROOT });
      await seedDoc(store, 'doc-precious', 'PRECIOUS-DOC');
      await createBackup(store, backupsDir);
      store.close();
      // Non-SQLite garbage: the boot integrity check fails and recovery runs.
      fs.writeFileSync(storePath, Buffer.alloc(4096, 0xde));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // No onStoreCorruption seam + a backup exists -> auto-restore (b6 pin).
      const host = new NodeBackendHost({
        token: TOKEN,
        storePath,
        storeEmbeddingDims: DIMS,
        engine: new StubEngine(),
        env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      });
      hosts.push(host);
      const handle = await host.start();
      // Degraded outcome: recovery never crashes the host.
      expect(handle.mode).toBe('node');
      const line = await waitForErrorLine(errorSpy, '[trainingapp-backend] store recovered (action=restore');
      expect(line).toContain(' from '); // restoredFrom names the backup
      // ...and the host serves the RESTORED store, not an empty one.
      const listed = await getJson(handle.port, '/documents');
      expect(listed.status).toBe(200);
      expect(listed.json?.total).toBe(1);
      await host.stop();
    },
    60_000,
  );
});

// --------------------------------------------------------------------------
// Group 4: refusal. RED at base (each refusal line was asserted nowhere);
// GREEN after this fix pins every malformed-input refusal line plus the
// continue-with-defaults (or skip-the-op) outcome.
// --------------------------------------------------------------------------
describe('i103b refusal contract sweep (#167)', () => {
  it('a non-object settings snapshot is refused with a log line and null stands in for defaults', () => {
    const dir = makeTempDir('i103b-refuse-settings1-');
    const storePath = path.join(dir, 'store.sqlite');
    const file = settingsPathFor(storePath);
    fs.writeFileSync(file, '[1, 2, 3]', 'utf8'); // valid JSON, not an object
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Never throws: the broken sidecar yields null (caller boots on defaults).
    expect(loadSettingsSnapshot(storePath)).toBeNull();
    expect(errorMessages(errorSpy)).toContain(
      `[trainingapp-backend] settings snapshot at ${file} is not a JSON object; ignoring`,
    );
  });

  it('an unparseable settings snapshot is refused with a log line and null stands in for defaults', () => {
    const dir = makeTempDir('i103b-refuse-settings2-');
    const storePath = path.join(dir, 'store.sqlite');
    const file = settingsPathFor(storePath);
    fs.writeFileSync(file, '{"rag_chunk_size": ', 'utf8'); // truncated JSON
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadSettingsSnapshot(storePath)).toBeNull();
    // The suffix is JSON.parse's own message; the static prefix is the contract.
    expect(
      errorMessages(errorSpy).some((m) =>
        m.startsWith(`[trainingapp-backend] could not parse settings snapshot at ${file}; ignoring (`),
      ),
    ).toBe(true);
  });

  it('non-object and unparseable external model sidecars are refused with log lines and null', () => {
    const dir = makeTempDir('i103b-refuse-external-');
    const storePath = path.join(dir, 'store.sqlite');
    const file = externalPathFor(storePath);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(file, '"just a string"', 'utf8'); // valid JSON, not an object
    expect(loadExternalSnapshot(storePath)).toBeNull();
    expect(errorMessages(errorSpy)).toContain(
      `[trainingapp-backend] external model settings at ${file} are not a JSON object; ignoring`,
    );
    fs.writeFileSync(file, '{"external.enabled": ', 'utf8'); // truncated JSON
    expect(loadExternalSnapshot(storePath)).toBeNull();
    expect(
      errorMessages(errorSpy).some((m) =>
        m.startsWith(`[trainingapp-backend] could not parse external model settings at ${file}; ignoring (`),
      ),
    ).toBe(true);
  });

  it('a refused external replay logs the OFF line, drops the base URL, and disables the external model', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const snapshot = { 'external.enabled': true, 'external.baseUrl': 'http://203.0.113.7/v1', 'external.model': 'm' };
    const refused = { ok: false as const, detail: 'airgap is on', errors: ['external.baseUrl: public URL refused'] };

    // Recovery path (:94): the retry without the URL is accepted.
    const appliedOne: Array<Record<string, unknown>> = [];
    replayExternalSnapshot(snapshot, (patch) => {
      appliedOne.push({ ...patch });
      return appliedOne.length === 1 ? refused : { ok: true };
    });
    // The retry continues with the external model OFF and the URL dropped.
    expect(appliedOne.length).toBe(2);
    expect(appliedOne[1]['external.enabled']).toBe(false);
    expect(Object.keys(appliedOne[1])).not.toContain('external.baseUrl');
    expect(errorMessages(errorSpy)).toContain(
      '[trainingapp-backend] stored external model settings were refused (airgap is on; external.baseUrl: public URL refused); the external model is OFF and its base URL was dropped',
    );

    // Last-resort path (:100): every retry refused -> disabled-only fallback.
    const appliedTwo: Array<Record<string, unknown>> = [];
    replayExternalSnapshot(snapshot, (patch) => {
      appliedTwo.push({ ...patch });
      return refused;
    });
    expect(appliedTwo.length).toBe(3);
    expect(appliedTwo[2]).toEqual({ 'external.enabled': false });
    expect(errorMessages(errorSpy)).toContain(
      '[trainingapp-backend] stored external model settings were refused (airgap is on; external.baseUrl: public URL refused); the external model is OFF',
    );
  });

  it('invalid packs-security env values are refused per key and the pinned defaults apply', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = resolvePacksSecurity({
      TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES: 'not-a-number',
      TRAININGAPP_PACKS_MAX_ENTRIES: '0',
      TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO: 'zero',
      TRAININGAPP_PACKS_TRUSTED_KEYS: 'not-json',
    });
    // Each malformed value logs its exact refusal line...
    const messages = errorMessages(errorSpy);
    expect(messages).toContain(
      `[pack-extract] ignoring invalid TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES=not-a-number; using the default ${DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES}`,
    );
    expect(messages).toContain(
      `[pack-extract] ignoring invalid TRAININGAPP_PACKS_MAX_ENTRIES=0; using the default ${DEFAULT_PACKS_MAX_ENTRIES}`,
    );
    expect(messages).toContain(
      `[pack-extract] ignoring invalid TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO=zero; using the default ${DEFAULT_PACKS_MAX_COMPRESSION_RATIO}`,
    );
    // ...the malformed trusted keyset fails closed (trusts NOTHING)...
    expect(
      messages.some((m) => m.startsWith('[pack-extract] ignoring invalid TRAININGAPP_PACKS_TRUSTED_KEYS: ')),
    ).toBe(true);
    // ...and the caller continues with the pinned defaults, never a throw.
    expect(resolved.maxUncompressedBytes).toBe(DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES);
    expect(resolved.maxEntries).toBe(DEFAULT_PACKS_MAX_ENTRIES);
    expect(resolved.maxCompressionRatio).toBe(DEFAULT_PACKS_MAX_COMPRESSION_RATIO);
    expect(resolved.trustedKeys).toEqual([]);
  });

  itReal(
    'a failed clear-cache sidecar removal is logged and the surface still reinitializes the store',
    async () => {
      const dir = makeTempDir('i103b-refuse-clearcache-');
      const dbPath = path.join(dir, 'store.sqlite');
      const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
      await seedDoc(store, 'doc-i103b-cc', 'i103bcczebra');
      let current: StoreHandle | null = store;
      const surface = new StoreDocumentSurface({
        getStore: () => current,
        setStore: (handle) => {
          current = handle;
        },
        embedder: new HashEmbedder({ dims: DIMS }),
        config: resolveIngestConfig({}),
        repoRoot: REPO_ROOT,
      });
      try {
        expect((await surface.listDocuments()).total).toBe(1);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Seam mock (b2 token-lifecycle fs-spy precedent): only the -shm
        // removal fails; every other fs.rmSync call is the real one.
        const realRmSync = fs.rmSync;
        vi.spyOn(fs, 'rmSync').mockImplementation((target: fs.PathLike, options?: fs.RmOptions) => {
          if (String(target).endsWith('-shm')) {
            throw new Error('injected clear-cache rm failure');
          }
          return realRmSync(target, options);
        });
        // Never throws: the failed removal is logged and Clear Cache continues.
        await surface.clearDocuments();
        expect(errorMessages(errorSpy)).toContain(
          `[trainingapp-store] clear-cache: failed to remove ${dbPath}-shm: injected clear-cache rm failure`,
        );
        // The op completed: a fresh empty store is installed and serving.
        expect(current).not.toBeNull();
        expect((await surface.listDocuments()).total).toBe(0);
      } finally {
        current?.close();
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Issue #203 AC4 (batch-143-203-204-212-213-215): UNGATED adoption row — the
// real-store groups must take the shared skip path (staging instruction in the
// skip titles) when the native addon is absent. Named mutant: restore a bare
// `? it : it.skip` gate (or strip the staging instruction from the factory's
// skip message) and this row must go red.
// ---------------------------------------------------------------------------
const GATE_PROBE_ENV = 'TRAININGAPP_TEST_GATE_PROBE';

describe('native-deps gate adoption (issue #203)', () => {
  it('gate-adoption-real-store: forced-absent skips the real-store rows with the shared staging instruction', () => {
    // Nested-run self-exclusion: this row IS the probe, so the nested run
    // (which sets GATE_PROBE_ENV) must not spawn another nested run.
    if (process.env[GATE_PROBE_ENV] === '1') return;
    const env = {
      ...process.env,
      TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1',
      [GATE_PROBE_ENV]: '1',
    };
    delete env.CI;
    const result = spawnSync(
      `npm --prefix desktop test -- src/__tests__/i103b-degrade-contract-sweep.test.ts --reporter=verbose`,
      { shell: true, cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 240_000 },
    );
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    // Every real-store row took the shared skip path (same message i169 produces).
    expect(out, out).toContain(NATIVE_DEPS_SKIP_MARKER);
    expect(out, out).toContain(STAGING_INSTRUCTION);
    expect(out, out).toMatch(/[1-9][0-9]* skipped/);
    // The ungated groups keep running on a deps-less box, and the run is green.
    expect(out, out).toMatch(/[1-9][0-9]* passed/);
    expect(result.status, out).toBe(0);
  });
});
