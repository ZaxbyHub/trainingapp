// logline-contract-sweep.test.ts — issue #201 (collated batch
// 201-207-208-209-210): pin the 17 residual log-line and doc-comment
// contract claims the test-batch-oct2026 recurrence sweep dispositioned
// COVERED-DEFERRED, as executable assertions (exact interpolated text +
// the paired state each line promises).
//
// Lifecycle: RED at base (this file did not exist at 035fffab - frozen C1..C4
// drivers prove it with the 'No test files found' signature), GREEN after the
// fix. The frozen row contract is reproducible-check-enforced: exactly 6 rows
// under 'index-degrade-lines', 2 under 'index-sidecar-lines', 4 under
// 'pack-manager-lines', 5 under 'comment-contracts'.
//
// SELECTOR CONTRACT (frozen -t drivers, i103b pattern): the four group titles
// below carry the tokens index-degrade-lines / index-sidecar-lines /
// pack-manager-lines / comment-contracts and those tokens appear in NO other
// GROUP title in this file (row titles inside a group may echo their group
// token), so `vitest run <this-file> -t <token>` selects exactly one group.
//
// PRIOR-ART (03-localization reconciliation): i103-degrade-assertions.test.ts
// pins SUBSTRING PREFIXES of sites 1/2 and b5-store.test.ts:190 a loose prefix
// of site 3. These pins extend them to the FULL interpolated line text AND the
// paired state write — the half no existing suite reads. Do not "simplify"
// them back to prefix checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StubEngine } from '../../main/backend/engine.js';
import { NodeBackendHost, recoverOrDegradeStore } from '../../main/backend/index.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { StoreDocumentSurface } from '../../main/backend/store/document-surface.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { EMPTY_FIRST_RUN_STATE, loadFirstRunState, firstRunStatePathFor } from '../../main/first-run/first-run-store.js';
import {
  __resetLaunchTokenForTests,
  getLaunchToken,
  initializeLaunchToken,
} from '../../main/security/token.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const TOKEN = 'i201-logline-token';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** All first-arg strings a console spy captured so far (i103b idiom). */
function logMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => String(args[0]));
}

function requireLine(messages: string[], needle: string, label: string): string {
  const hit = messages.find((m) => m === needle);
  if (hit === undefined) {
    throw new Error(
      `${label}: expected the EXACT contract line ${JSON.stringify(needle)}; captured: ${JSON.stringify(
        messages.slice(0, 12).map((m) => m.slice(0, 200)),
      )}`,
    );
  }
  return hit;
}

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    try {
      await host.stop();
    } catch {
      /* teardown best effort */
    }
  }
  while (openStores.length > 0) {
    const store = openStores.pop();
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('../../main/backend/retrieval/reranker.js');
  vi.doUnmock('../../main/backend/store/recovery.js');
  vi.doUnmock('../../main/backend/sidecar-manager.js');
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Group 1 (C1): index.ts availability/degrade lines - exact text + paired state
// ---------------------------------------------------------------------------
describe('index-degrade-lines (#201 AC1: exact contract line + degraded state)', () => {
  it('worker-pool rejection logs the exact B7 single-thread line and mirrors it as telemetry', async () => {
    // Named mutant: reword the >1 rejection detail (index.ts:576-577) -> red.
    vi.stubEnv('TRAININGAPP_RERANKER_WORKER_POOL_SIZE', '2');
    const dir = makeTempDir('i201-pool-');
    tempDirs.push(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const telemetry: Array<{ type: string; detail?: string }> = [];
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath: path.join(dir, 'store.sqlite'),
      storeEmbeddingDims: 8,
      engine: new StubEngine(),
      onMemoryEvent: (event) => telemetry.push(event as { type: string; detail?: string }),
    });
    hosts.push(host);
    const handle = await host.start();
    expect(handle.mode).toBe('node');
    const exact =
      '[trainingapp-backend] worker pool sizes > 1 rejected (B7 single-thread ORT ownership: ' +
      'a second ONNX instance on another thread aborts the process); continuing with 1';
    requireLine(logMessages(errorSpy), exact, 'worker-pool rejection line');
    const mirror = telemetry.find((e) => e.type === 'telemetry' && e.detail === exact.slice('[trainingapp-backend] '.length));
    expect(mirror, 'the rejection detail is mirrored through onMemoryEvent telemetry').toBeDefined();
  });

  it('embedding model unavailable logs the exact line with the interpolated error and writes the paired state', async () => {
    // Deterministic trigger (issue-103 recipe): a nonexistent repo root with
    // empty model envs makes every resolveEmbedder candidate invalid.
    const dir = makeTempDir('i201-embedder-');
    tempDirs.push(dir);
    vi.stubEnv('TRAININGAPP_DESKTOP_REPO_ROOT', path.join(dir, 'no-such-repo-root'));
    vi.stubEnv('TRAININGAPP_EMBEDDING_MODEL_DIR', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_EMBEDDER', '');
    vi.stubEnv('TRAININGAPP_RERANKER_MODEL_DIR', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_RERANKER_STUB', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath: path.join(dir, 'store.sqlite'),
      storeEmbeddingDims: 8,
      engine: new StubEngine(),
    });
    hosts.push(host);
    const handle = await host.start();
    expect(handle.mode).toBe('node');
    const status = host.getPackLifecycleStatus();
    expect(status.startsWith('embedder-unavailable: ')).toBe(true);
    const message = status.slice('embedder-unavailable: '.length);
    expect(message.length).toBeGreaterThan(0);
    requireLine(
      logMessages(errorSpy),
      `[trainingapp-backend] embedding model unavailable (store surface degrades to embedder-less): ${message}`,
      'embedder degrade line',
    );
  });

  it('reranker unavailable logs the exact fused-ordering line with the injected message and the host still serves', async () => {
    // Scoped mock (i103 recipe): resolveRerankerModelDir throws. Disclosed
    // limitation (same as i103): the throw fires pre-construction, so the
    // private reranker/resumable/idle null-outs are structurally satisfied
    // (never constructed); the observable pairing pinned here is that
    // retrieval continues to serve (fused ordering) and start never fails.
    const dir = makeTempDir('i201-reranker-');
    tempDirs.push(dir);
    vi.stubEnv('TRAININGAPP_DESKTOP_REPO_ROOT', path.join(dir, 'no-such-repo-root'));
    vi.stubEnv('TRAININGAPP_EMBEDDING_MODEL_DIR', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_EMBEDDER', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_RERANKER_STUB', '');
    vi.resetModules();
    vi.doMock('../../main/backend/retrieval/reranker.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../main/backend/retrieval/reranker.js')>();
      return {
        ...actual,
        resolveRerankerModelDir: () => {
          throw new Error('injected reranker resolve failure');
        },
      };
    });
    const { NodeBackendHost: Host } = await import('../../main/backend/index.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = new StubEngine();
    const host = new Host({
      token: TOKEN,
      storePath: path.join(dir, 'store.sqlite'),
      storeEmbeddingDims: 8,
      engine,
    });
    hosts.push(host);
    const handle = await host.start();
    expect(handle.mode).toBe('node');
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] reranker unavailable (retrieval degrades to fused ordering): injected reranker resolve failure',
      'reranker degrade line',
    );
    // Paired state as far as it is observable: the reranker never constructed
    // (throw fires pre-construction, disclosed i103 limitation) and retrieval
    // keeps serving through the stub/fused path.
    const results = await engine.search('anything');
    expect(results.length).toBeGreaterThan(0);
  });

  it('a non-corrupt store open failure logs the exact continuing-without-store line and returns null', async () => {
    // Site 4: file never created (existsSync false) -> degradation, null.
    const dir = makeTempDir('i201-storeopen-');
    tempDirs.push(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await recoverOrDegradeStore(
      { token: TOKEN, storePath: path.join(dir, 'absent.sqlite'), storeEmbeddingDims: 8 },
      new Error('injected open failure'),
    );
    expect(handle).toBeNull();
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] store init failed (continuing without store): injected open failure',
      'store open-failure degrade line',
    );
  });

  it('a recovery that cannot restore logs the exact give-up line and returns null', async () => {
    // Site 5: corrupt (not integrity-ok) file; recoverStore throws.
    const dir = makeTempDir('i201-recovery-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.sqlite');
    fs.writeFileSync(dbPath, 'pretend corrupt store bytes');
    vi.resetModules();
    vi.doMock('../../main/backend/store/recovery.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../main/backend/store/recovery.js')>();
      return {
        ...actual,
        recoverStore: async () => {
          throw new Error('injected recovery failure');
        },
      };
    });
    const { recoverOrDegradeStore: recover } = await import('../../main/backend/index.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await recover(
      { token: TOKEN, storePath: dbPath, storeEmbeddingDims: 8 },
      new Error('injected open failure'),
    );
    expect(handle).toBeNull();
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] store init failed (continuing without store): recovery could not restore the corrupt store: injected recovery failure',
      'store recovery give-up line',
    );
  });

  it('no staged embedding model logs the exact ingest-stubbed line and leaves documents stubbed', async () => {
    // Site 6: store opens (real addons locally), embedder null ->
    // attachStoreSurface detaches and the engine keeps its stub contract.
    const dir = makeTempDir('i201-ingeststub-');
    tempDirs.push(dir);
    vi.stubEnv('TRAININGAPP_DESKTOP_REPO_ROOT', path.join(dir, 'no-such-repo-root'));
    vi.stubEnv('TRAININGAPP_EMBEDDING_MODEL_DIR', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_EMBEDDER', '');
    vi.stubEnv('TRAININGAPP_RERANKER_MODEL_DIR', '');
    vi.stubEnv('TRAININGAPP_DESKTOP_RERANKER_STUB', '');
    const engine = new StubEngine();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath: path.join(dir, 'store.sqlite'),
      storeEmbeddingDims: 8,
      engine,
    });
    hosts.push(host);
    const handle = await host.start();
    expect(handle.mode).toBe('node');
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] ingest surface unavailable (documents stay stubbed): no embedding model staged',
      'ingest-stubbed line',
    );
    // Paired state: the document surface never attached - stub no-store contract.
    const stats = await engine.getStats();
    expect(stats.document_count).toBe(0);
    expect(stats.embedding_model).toBe('desktop-stub (B5 #63)');
  });
});

// ---------------------------------------------------------------------------
// Group 2 (C2): index.ts sidecar restart lines
// ---------------------------------------------------------------------------
describe('index-sidecar-lines (#201 AC2: exact restart + give-up lines)', () => {
  it('the restart event logs the exact backoff line with attempt and delay interpolated', async () => {
    const manager = await startStubSidecarHost();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.emit('restart', 2, 4321);
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] sidecar exited; restarting (attempt 2 after 4321ms backoff)',
      'sidecar restart line',
    );
  });

  it('the gave-up event logs the exact bound-exceeded line and fires the onGiveUp seam once', async () => {
    const giveUps: number[] = [];
    const manager = await startStubSidecarHost({ onGiveUp: (attempts: number) => giveUps.push(attempts) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.emit('gave-up', 7);
    requireLine(
      logMessages(errorSpy),
      '[trainingapp-backend] sidecar restart bound exceeded after 7 restarts; giving up',
      'sidecar give-up line',
    );
    expect(giveUps, 'config.onGiveUp fires exactly once with the attempts count').toEqual([7]);
  });
});

/**
 * Start a SidecarBackendHost over a STUBBED SidecarManager (the host's
 * manager surface it uses is exactly on/start/stop - b3-sidecar-manager
 * contract). The stub captures the instance so the rows can drive the
 * 'restart'/'gave-up' events; the handlers under test are index.ts:1144-1150
 * registered by the host itself (not mocked).
 */
const stubSidecarManagers: Array<{ emit(event: string, ...args: unknown[]): void }> = [];
async function startStubSidecarHost(
  extraConfig: Record<string, unknown> = {},
): Promise<{ emit(event: string, ...args: unknown[]): void }> {
  vi.resetModules();
  vi.doMock('../../main/backend/sidecar-manager.js', async () => {
    const { EventEmitter } = await import('node:events');
    class FakeSidecarManager extends EventEmitter {
      readonly options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        super();
        this.options = options;
        stubSidecarManagers.push(this as unknown as { emit(event: string, ...args: unknown[]): void });
      }
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
    return { SidecarManager: FakeSidecarManager };
  });
  const { SidecarBackendHost } = await import('../../main/backend/index.js');
  const host = new SidecarBackendHost({
    token: TOKEN,
    sidecar: { command: 'stub-sidecar' },
    ...extraConfig,
  });
  hosts.push(host);
  const handle = await host.start();
  expect(handle.mode).toBe('sidecar');
  const manager = stubSidecarManagers[stubSidecarManagers.length - 1];
  if (manager === undefined) throw new Error('stub SidecarManager never constructed - mock did not apply');
  return manager;
}

// ---------------------------------------------------------------------------
// Group 3 (C3): pack-manager warning lines
// ---------------------------------------------------------------------------
describe('pack-manager-lines (#201 AC3: exact install-warning and manifest-degrade lines)', () => {
  async function makeWorkspace() {
    const root = makeTempDir('i201-packmgr-');
    tempDirs.push(root);
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    openStores.push(store);
    const { PackManager } = await import('../../main/backend/store/pack-manager.js');
    const manager = new PackManager({
      store,
      embedder: new HashEmbedder({ dims: 8 }),
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });
    return { root, store, manager };
  }

  function copyFixture(root: string, name: string, destName = name): string {
    const dest = path.join(root, destName);
    fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
    return dest;
  }

  function readManifest(packDir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8')) as Record<string, unknown>;
  }

  function writeManifest(packDir: string, manifest: Record<string, unknown>): void {
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  function writeDocRaw(packDir: string, rel: string, content: string): string {
    const p = path.join(packDir, rel);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('install warnings are logged per entry with the exact install <id>@<version>: <warning> shape', async () => {
    // Named mutant: reword the install-warning template (pack-manager.ts:607).
    const { root, manager } = await makeWorkspace();
    const bDir = copyFixture(root, 'versioned-a-1.0.0', 'pack-b-src');
    const manifest = readManifest(bDir);
    manifest.id = 'pack-b';
    manifest.name = 'Pack B';
    manifest.supersedes = ['ghost-pack@9.9.9'];
    writeManifest(bDir, manifest);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await manager.install(bDir);
    const warning = 'supersedes entry ghost-pack@9.9.9 names no installed pack version; recorded on the new row only';
    expect(result.warnings).toContain(warning);
    requireLine(logMessages(warnSpy), `[pack-manager] install pack-b@1.0.0: ${warning}`, 'install-warning line');
  });

  it('a missing managed manifest logs the exact unreadable line with its path and treats the row as no docs', async () => {
    const { root, manager } = await makeWorkspace();
    await manager.install(copyFixture(root, 'versioned-a-1.0.0', 'v1-src'));
    const install2 = await manager.install(copyFixture(root, 'versioned-a-2.0.0', 'v2-src'));
    const manifestPath = path.join(install2.installPath, 'pack.json');
    fs.rmSync(manifestPath);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await manager.rollback('versioned-a', '1.0.0');
    requireLine(
      logMessages(warnSpy),
      `[pack-manager] versioned-a@2.0.0: managed manifest unreadable at ${manifestPath}; treating as no docs`,
      'manifest-unreadable line',
    );
  });

  it('a corrupt managed manifest logs the exact unparseable line with its path and treats the row as no docs', async () => {
    const { root, manager } = await makeWorkspace();
    await manager.install(copyFixture(root, 'versioned-a-1.0.0', 'v1-src'));
    const install2 = await manager.install(copyFixture(root, 'versioned-a-2.0.0', 'v2-src'));
    const manifestPath = path.join(install2.installPath, 'pack.json');
    fs.writeFileSync(manifestPath, '{ this is not json', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await manager.rollback('versioned-a', '1.0.0');
    requireLine(
      logMessages(warnSpy),
      `[pack-manager] versioned-a@2.0.0: managed manifest unparseable at ${manifestPath}; treating as no docs`,
      'manifest-unparseable line',
    );
  });

  it('deactivating a row whose doc chunks are gone logs the exact no-live-chunks line with the doc id', async () => {
    // v2's doc content is rewritten so its doc_id (content sha) is distinct
    // from v1's; the chunks for that doc are deleted out-of-band, and the
    // rollback deactivation of the 2.0.0 row must hit the 1310-1313 branch.
    const { root, store, manager } = await makeWorkspace();
    await manager.install(copyFixture(root, 'versioned-a-1.0.0', 'v1-src'));
    const v2Dir = copyFixture(root, 'versioned-a-2.0.0', 'v2-src');
    writeDocRaw(v2Dir, 'docs/a.json', JSON.stringify({ text: 'distinct v2 payload for the no-live-chunks pin' }, null, 2));
    const manifest = readManifest(v2Dir);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(fs.readFileSync(path.join(v2Dir, 'docs/a.json'))).digest('hex');
    const docs = manifest.docs as Array<{ path: string; sha256: string }>;
    docs[0].sha256 = sha;
    writeManifest(v2Dir, manifest);
    await manager.install(v2Dir);
    const db = store.db as unknown as { prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
    // deleteDocumentLocked returns false only when BOTH the chunks AND the
    // docs row are gone - the out-of-band wipe must remove both (embeddings/
    // fts/links rows cascade with the chunk delete inside the manager path).
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(sha);
    db.prepare('DELETE FROM docs WHERE id = ?').run(sha);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await manager.rollback('versioned-a', '1.0.0');
    requireLine(
      logMessages(warnSpy),
      `[pack-manager] versioned-a@2.0.0: no live chunks for doc ${sha}; row deactivated`,
      'no-live-chunks line',
    );
  });
});

// ---------------------------------------------------------------------------
// Group 4 (C4): doc-comment invariants become executable assertions
// ---------------------------------------------------------------------------
describe('comment-contracts (#201 AC4: the prose promise is now an assertion)', () => {
  it('protocol.ts keeps the exactly-once contract prose and the bootstrap has a single call site', () => {
    // Named mutant: delete the comment or add a second registerAppProtocol(
    // call site in bootstrap - either flips this row.
    const protocol = fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'main', 'protocol.ts'), 'utf8');
    expect(protocol).toMatch(/Call after `app` is ready\. Must be called exactly once\./);
    const bootstrap = fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'main', 'index.ts'), 'utf8');
    const callSites = bootstrap.match(/(^|[^.\w])registerAppProtocol\s*\(/gm) ?? [];
    expect(callSites, 'bootstrap must call registerAppProtocol exactly once').toHaveLength(1);
    const handlerSites = protocol.match(/protocol\.handle\(\s*'app'/g) ?? [];
    expect(handlerSites, 'protocol.handle("app") lives only in registerAppProtocol').toHaveLength(1);
  });

  it('pipeline per-file failure resolves success:false and never throws for an embedding-stage failure', async () => {
    // Named mutant: rethrow from ingestOne instead of catching -> reject red.
    const root = makeTempDir('i201-pipeline-');
    tempDirs.push(root);
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    openStores.push(store);
    const surface = new StoreDocumentSurface({
      getStore: () => store,
      setStore: () => undefined,
      embedder: {
        modelId: 'throwing-embedder',
        embed: async () => {
          throw new Error('injected embed-stage failure');
        },
      },
      config: { maxConcurrentFiles: 1, chunkWordCount: 256, chunkOverlapWords: 100 },
    });
    const result = await surface.ingestFile({ name: 'a.txt', data: Buffer.from('hello logline contract world', 'utf8') });
    expect(result.success).toBe(false);
    expect(result.message ?? '').toContain('injected embed-stage failure');
    const batch = await surface.ingestBatch([
      { name: 'b.txt', data: Buffer.from('second failing doc', 'utf8') },
    ]);
    expect(batch.successful).toBe(0);
    expect(batch.failed).toBe(1);
  });

  it('first-run state reads never throw on absent, empty, and corrupt sidecars and return defaults', () => {
    // Named mutant: drop the try/catch or the shape guard -> throws red.
    const dir = makeTempDir('i201-frs-');
    tempDirs.push(dir);
    const storePath = path.join(dir, 'store.sqlite');
    const expected = EMPTY_FIRST_RUN_STATE();
    // absent
    expect(loadFirstRunState(storePath)).toEqual(expected);
    // empty
    const file = firstRunStatePathFor(storePath);
    fs.writeFileSync(file, '', 'utf8');
    expect(loadFirstRunState(storePath)).toEqual(expected);
    // corrupt bytes
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(loadFirstRunState(storePath)).toEqual(expected);
    // valid JSON, wrong shape
    fs.writeFileSync(file, JSON.stringify({ nope: true }), 'utf8');
    expect(loadFirstRunState(storePath)).toEqual(expected);
  });

  it('initializeLaunchToken is exactly-once idempotent and every reader gets the same value', () => {
    // Named mutant: drop the null guard (re-mint per call) -> red.
    __resetLaunchTokenForTests();
    const first = initializeLaunchToken();
    const second = initializeLaunchToken();
    expect(second).toBe(first);
    expect(getLaunchToken()).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the test hook clears the holder so a fresh init mints a new value with fail-fast reads in between', () => {
    // Named mutant: make __reset a no-op (same value after re-init) -> red.
    __resetLaunchTokenForTests();
    const first = initializeLaunchToken();
    __resetLaunchTokenForTests();
    expect(() => getLaunchToken()).toThrow(/not initialized/);
    const second = initializeLaunchToken();
    expect(second).not.toBe(first);
    expect(getLaunchToken()).toBe(second);
    __resetLaunchTokenForTests();
  });
});
