// frozen-check C4 (rev 5 — critic Round-4 R4-6 amendment: drive the REAL
// production compositions; add host-wiring + multi-version remove legs) —
// #373 AC1: every desktop pack install/remove COMMIT produces EXACTLY ONE
// audit envelope at the delivery seam — none missing (committed-but-cleanup-
// failed remove and signed-update applied:false-after-commit included), none
// duplicated, none for failed-before-commit attempts — plus the bundled-boot
// wrapper, the production host wiring, version-less multi-version remove,
// and the settings custody seam bound to the OUTER settings commit.
//
// FROZEN SPEC — authored by the independent check author at base
// 54107572c092febc00beff17f719ff631a2215ac, before any implementation
// exists; the implementer makes it pass WITHOUT editing it (canonical copy:
// the issue trace at frozen/desktop/src/__tests__/). RED at
// base (vitest's file-absent signature: `No test files found`), GREEN after
// the fix. Dropped into the pre-fix tree: every pack/custody behavior leg
// fails at its envelope-count assertion (custody at its success-path count;
// its rollback path sits behind it pre-fix); the no-envelope leg passes
// vacuously (disclosed); the wiring leg fails at the captured PackManager
// options lacking the sink; the multi-version leg at its remove count.
// WAVE-5 ROSTER (critic R5-6/R5-5): the real-builder production composition,
// the post-COMMIT outbox push, and the API-key CLEAR custody leg live in the
// frozen companion audit-outbox-composition.test.ts (same driver, both run).
//
// CHECK_WRONG rev 6 (Phase 4 execution): the cleanup-failed remove leg used
// chmod(0444), which does not fail directory removal on current Windows/Node.
// It now injects one real fs.rmSync failure; the commit/audit path is unchanged.
// Harness contract (declared for the implementer — mirrors c7-packs-api:
// REAL server + REAL PackManager over HTTP): PackManager gains ONE producer
// seam option — new PackManager({ store, embedder, packsRoot, repoRoot,
// packsSecurity, auditSink }) — where auditSink?: { emit(envelope): void }
// fires EXACTLY ONCE per committed install/remove transaction and NEVER for
// failed-before-commit attempts (production passes the outbox producer;
// this spec passes a recorder). BackendHostConfig gains the same auditSink?
// shape; the host's PackManager construction (backend/index.ts:1203-1208
// behind createBackendHost :1598) threads config.auditSink into the options.
// DesktopAuditEnvelope: { eventId: string (unique per COMMIT, the dedup
// key); event: 'pack_install'|'pack_remove'|'settings_change'; subject:
// `${packId}@${version}` for versioned pack rows, the BARE packId for a
// version-less multi-version remove, the settings KEY for custody;
// occurredAt: number (commit time, ms epoch) }.
//   - REV 4 custody seam (critic R3 Blocker 5): TWO-PHASE, OUTER-COMMIT-
//     BOUND. ExternalProvider Options gain auditSink?: { capture(envelope):
//     void; // at saveKey/clearKey — NO durable effect alone; flush(): void;
//     // ONLY when the OUTER commitSettingsChange (server.ts) succeeds;
//     discard(): void } — commit() alone must NOT yield an envelope (the
//     false-row-on-rollback hole, frozen shut).
//   - Compositions: (1) committed-but-cleanup-failed remove (read-only
//     managed-dir file → fs.rmSync throws on Windows AFTER the tx commits;
//     route 409, yet the commit happened); (2) signed-update applied:false-
//     after-commit via the REAL applyPackUpdate (update-checker.ts:767-804,
//     check :791-799) + REAL loopbackPackInstaller (:737-759); (3) bundled
//     boot via the REAL getFirstRunPackTools wrapper (backend/index.ts:
//     672-689); (4) installer rejection; (5) custody outer-commit two-phase
//     (success + rollback) over the REAL PUT /settings route; (6) host
//     wiring (createBackendHost threads config.auditSink into the
//     constructed PackManager options); (7) version-less multi-version
//     remove (pack-manager.ts:715-775 → ONE envelope, subject = the bare
//     packId). No Electron boot needed.
import { afterEach, describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { applyPackUpdate, loopbackPackInstaller } from '../../main/update-checker.js';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

// Construction capture for the wiring leg: a faithful subclass around the
// REAL PackManager export (identical behavior for every other leg; while
// armed it records the options production passed to the constructor).
const pmCapture = vi.hoisted(() => ({ armed: false, options: [] as unknown[] }));
vi.mock('../../main/backend/store/pack-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/store/pack-manager.js')>();
  const RealPackManager = actual.PackManager;
  return { ...actual, PackManager: class extends RealPackManager {
    constructor(opts: ConstructorParameters<typeof RealPackManager>[0]) { if (pmCapture.armed) pmCapture.options.push(opts); super(opts); }
  } };
});

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
const itReal = nativeDepsIt('audit-desktop-producer');
const TOKEN = 'audit-desktop-producer-token';
const TOKEN_HEADER = 'x-desktop-token';

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
const openServers: http.Server[] = [];
const startedHosts: Array<{ stop(): Promise<void> }> = [];
/** Managed-dir files marked read-only (Windows rmSync sabotage) — restored in afterEach. */
const readonlyFiles: string[] = [];

afterEach(async () => {
  while (startedHosts.length > 0) await startedHosts.pop()!.stop().catch(() => undefined);
  for (const file of readonlyFiles.splice(0)) { try { fs.chmodSync(file, 0o666); } catch { /* gone */ } }
  for (const server of openServers.splice(0)) { try { server.close(); } catch { /* closed */ } }
  for (const store of openStores.splice(0)) { try { store.close(); } catch { /* closed */ } }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir;
}

/** The declared delivery-seam payload (harness contract in the header). */
interface DesktopAuditEnvelope {
  eventId: string;
  event: 'pack_install' | 'pack_remove' | 'settings_change';
  subject: string;
  occurredAt: number;
}

/** Recording sink: the spec's observer at the declared producer seam. */
function makeSink(): { emitted: DesktopAuditEnvelope[]; sink: { emit(envelope: DesktopAuditEnvelope): void } } {
  const emitted: DesktopAuditEnvelope[] = [];
  return { emitted, sink: { emit(envelope: DesktopAuditEnvelope): void { emitted.push({ ...envelope }); } } };
}

interface Workspace {
  root: string;
  manager: {
    install(packPath: string): Promise<{ packId: string; version: string }>;
    remove(packId: string, version?: string): Promise<number>;
    listInstalled(): Promise<Array<{ packId: string; version: string; installPath: string | null }>>;
  };
}

async function makeWorkspace(auditSink: { emit(envelope: DesktopAuditEnvelope): void }): Promise<Workspace> {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  const root = makeTempDir('audit-desktop-producer-');
  const store = storeMod.openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
  openStores.push(store);
  const manager = new managerMod.PackManager({
    store,
    embedder: new embedderMod.HashEmbedder({ dims: 8 }),
    packsRoot: path.join(root, 'packs'),
    repoRoot: REPO_ROOT,
    packsSecurity: { embeddingModelId: 'hash-test' },
    auditSink,
  });
  return { root, manager };
}

/** Copy a fixture pack, retargeting its embedding block to the test HashEmbedder (c7's rewrite). */
function stageFixture(root: string, name: string): string {
  const dest = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  const manifestPath = path.join(dest, 'pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.embedding = { model_id: 'hash-test', dims: 8, normalize: false };
  for (const entry of manifest.docs as Array<{ path: string; sha256: string }>) {
    entry.sha256 = createHash('sha256').update(fs.readFileSync(path.join(dest, entry.path))).digest('hex');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dest;
}

/** Zip a staged pack folder (jszip — the same prod dep the route uses). */
async function zipPackDir(packDir: string): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const addDir = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) addDir(full, rel);
      else zip.file(rel, fs.readFileSync(full));
    }
  };
  addDir(packDir, '');
  return zip.generateAsync({ type: 'uint8array' });
}

function buildMultipartBody(boundary: string, filename: string, data: Uint8Array): Buffer {
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`, 'utf8');
  return Buffer.concat([head, Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
}

async function startServer(manager: unknown, extras?: { engine?: unknown; persistExternal?: () => void; persistSettings?: () => void }): Promise<{ port: number }> {
  const serverMod = await import('../../main/backend/server.js');
  const guardMod = await import('../../main/security/loopback-guard.js');
  const engineMod = await import('../../main/backend/engine.js');
  const surfaceMod = await import('../../main/backend/packs/surface.js');
  const server = serverMod.createBackendServer({
    guard: guardMod.createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine: (extras?.engine as never) ?? new engineMod.StubEngine(), // Node-mode dispatch requires an engine surface even for pack routes
    ...(extras?.persistExternal !== undefined ? { persistExternal: extras.persistExternal } : {}),
    ...(extras?.persistSettings !== undefined ? { persistSettings: extras.persistSettings } : {}),
    packs: () => surfaceMod.createPackSurface(manager as never),
  });
  const port = await serverMod.listenOnRandomPort(server);
  openServers.push(server);
  return { port };
}

async function get(port: number, reqPath: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${reqPath}`, { headers: { [TOKEN_HEADER]: TOKEN } });
}

async function postInstall(port: number, zip: Uint8Array): Promise<Response> {
  const boundary = 'auditproducerboundary';
  return fetch(`http://127.0.0.1:${port}/packs/install`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: buildMultipartBody(boundary, 'pack.zip', zip),
  });
}

async function postJson(port: number, reqPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${reqPath}`, {
    method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function putSettings(port: number, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings`, {
    method: 'PUT', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
}

/** Shape pins for the declared envelope contract (every field, every row). */
function expectEnvelopeShape(envelopes: DesktopAuditEnvelope[]): void {
  for (const envelope of envelopes) {
    expect(envelope.eventId, 'each envelope carries a non-empty unique eventId (the dedup key)').toMatch(/.+/);
    expect(['pack_install', 'pack_remove', 'settings_change']).toContain(envelope.event);
    expect(typeof envelope.subject).toBe('string');
    expect(envelope.subject.length, 'the subject is a stable id (packId@version), never empty').toBeGreaterThan(0);
    expect(typeof envelope.occurredAt).toBe('number');
    expect(envelope.occurredAt).toBeGreaterThan(0);
  }
  const ids = new Set(envelopes.map((e) => e.eventId));
  expect(ids.size, 'no two commits share an eventId (no duplicate rows per commit)').toBe(envelopes.length);
}

describe('audit-desktop-producer: pack commits produce exactly one audit envelope each (#373 AC1)', () => {
  itReal('a normal install commit and a normal remove commit each deliver EXACTLY ONE envelope for that commit (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    const { port } = await startServer(ws.manager);
    const staged = stageFixture(ws.root, 'bundled-min');
    const zip = await zipPackDir(staged);
    const installRes = await postInstall(port, zip);
    expect(installRes.status).toBe(200);
    const installBody = (await installRes.json()) as { pack_id: string; version: string };
    expect(installBody.pack_id).toBe('bundled-min');
    const installEnvelopes = emitted.filter((e) => e.event === 'pack_install' && e.subject.includes('bundled-min'));
    expect(installEnvelopes.length, 'the install commit must deliver exactly ONE pack_install envelope').toBe(1);
    expectEnvelopeShape(installEnvelopes);
    const removeRes = await postJson(port, '/packs/remove', { pack_id: 'bundled-min', version: installBody.version });
    expect(removeRes.status).toBe(200);
    const removeEnvelopes = emitted.filter((e) => e.event === 'pack_remove' && e.subject.includes('bundled-min'));
    expect(removeEnvelopes.length, 'the remove commit must deliver exactly ONE pack_remove envelope').toBe(1);
    expectEnvelopeShape(emitted);
    expect(emitted.length, 'exactly two commits happened: exactly two envelopes total').toBe(2);
  });

  itReal('a committed-but-cleanup-failed remove STILL delivers exactly ONE envelope — the awaited response misses the commit (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    const { port } = await startServer(ws.manager);
    const staged = stageFixture(ws.root, 'versioned-a-1.0.0');
    const zip = await zipPackDir(staged);
    const installRes = await postInstall(port, zip);
    expect(installRes.status).toBe(200);
    const installBody = (await installRes.json()) as { pack_id: string; version: string };
    expect(installBody.pack_id).toBe('versioned-a');
    expect(emitted.filter((e) => e.event === 'pack_install').length).toBe(1);
    // Sabotage cleanup: a read-only file makes fs.rmSync throw on Windows AFTER the tx committed.
    const rows = await ws.manager.listInstalled();
    const installed = rows.find((r) => r.packId === 'versioned-a');
    expect(installed?.installPath, 'the installed row carries its managed dir').toBeTruthy();
    // CHECK_WRONG rev 6: chmod(0444) does not make directory removal fail
    // under current Windows/Node semantics. Inject the cleanup failure at the
    // real fs.rmSync seam; the registry transaction and audit emit still run
    // through the real PackManager/server path.
    const realRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('probe: managed-directory cleanup failed');
    });
    let removeRes: Response;
    try {
      removeRes = await postJson(port, '/packs/remove', { pack_id: 'versioned-a', version: installBody.version });
    } finally {
      rmSpy.mockRestore();
      void realRmSync;
    }
    // The route surfaces the cleanup failure (PackManagerError -> 409), but the COMMIT already happened.
    expect(removeRes.status).toBe(409);
    const listRes = await get(port, '/packs');
    const listBody = (await listRes.json()) as { packs: Array<{ pack_id: string }> };
    expect(listBody.packs.some((p) => p.pack_id === 'versioned-a'), 'the remove tx COMMITTED though the response errored').toBe(false);
    const removeEnvelopes = emitted.filter((e) => e.event === 'pack_remove' && e.subject.includes('versioned-a'));
    expect(removeEnvelopes.length, 'the committed-but-cleanup-failed remove must deliver exactly ONE pack_remove envelope').toBe(1);
    expectEnvelopeShape(emitted);
    expect(emitted.length).toBe(2);
  });

  itReal('a failed-before-commit install attempt delivers NO envelope (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    const { port } = await startServer(ws.manager);
    // Zip with a traversal entry path: rejected before any transaction runs.
    const JSZip = (await import('jszip')).default;
    const evil = new JSZip();
    evil.file('../escape.txt', 'nope');
    const evilBytes = await evil.generateAsync({ type: 'uint8array' });
    const evilRes = await postInstall(port, evilBytes);
    expect([409, 422]).toContain(evilRes.status);
    const ghostRes = await postJson(port, '/packs/remove', { pack_id: 'never-installed' });
    expect(ghostRes.status).toBe(409);
    expect(emitted.length, 'failed-before-commit attempts must deliver ZERO envelopes').toBe(0);
  });

  itReal('signed-update composition: the REAL applyPackUpdate over the REAL loopbackPackInstaller — applied:false AFTER commit, exactly one envelope (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    const { port } = await startServer(ws.manager);
    // The #278 flow through the REAL production functions: a feed entry SIGNED
    // over the artifact digest (ed25519, update-checker.ts:258-307) whose
    // candidate claims 9.9.9 while the artifact is 1.0.0. The REAL
    // loopbackPackInstaller (update-checker.ts:737-759) POSTs and COMMITS; the
    // REAL applyPackUpdate (update-checker.ts:767-804) then rejects the
    // substituted identity at its :791-799 check.
    const staged = stageFixture(ws.root, 'versioned-a-1.0.0');
    const zip = await zipPackDir(staged);
    const digest = createHash('sha256').update(zip).digest('hex');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyId = 'audit-producer-signing-key';
    const trustedKeys = [{ key_id: keyId, public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }];
    const entry = {
      version: '9.9.9',
      published_at: '2026-01-01T00:00:00Z',
      sha256: digest,
      size_bytes: zip.byteLength,
      download_url: 'https://updates.example.invalid/versioned-a-9.9.9.zip',
      signature: { algorithm: 'ed25519', key_id: keyId, value: cryptoSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64') },
    };
    const outcome = await applyPackUpdate(
      { packId: 'versioned-a', currentVersion: '1.0.0', availableVersion: '9.9.9', publishedAt: entry.published_at, downloadUrl: entry.download_url, sha256: digest, sizeBytes: zip.byteLength },
      entry,
      {
        downloadArtifact: async () => zip, // the feed-declared bytes (digest + signature re-verified by the real verifier)
        installPack: loopbackPackInstaller(`http://127.0.0.1:${port}`, TOKEN, TOKEN_HEADER),
      },
      trustedKeys,
    );
    expect(outcome.applied, 'the REAL function reports applied:false though the install committed').toBe(false);
    expect(outcome.version).toBe('1.0.0');
    expect(outcome.reason).toContain('identity mismatch');
    expect(outcome.reason).toContain('versioned-a@9.9.9');
    expect(outcome.reason).toContain('versioned-a@1.0.0');
    const listRes = await get(port, '/packs');
    const listBody = (await listRes.json()) as { packs: Array<{ pack_id: string }> };
    expect(listBody.packs.some((p) => p.pack_id === 'versioned-a'), 'the install committed despite applied:false').toBe(true);
    const envelopes = emitted.filter((e) => e.event === 'pack_install' && e.subject.includes('versioned-a'));
    expect(envelopes.length, 'applied:false-after-commit still delivers exactly ONE envelope').toBe(1);
    expectEnvelopeShape(envelopes);
  });

  itReal('bundled-boot composition: the REAL getFirstRunPackTools wrapper (backend/index.ts:672-689) delivers exactly one envelope (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    // The REAL wrapper on a REAL createBackendHost instance; its only state
    // dependency is this.packManager, so the minimal surface context pins that
    // field to the sink-carrying manager (the adapter main/index.ts:851 drives).
    const hostMod = await import('../../main/backend/index.js');
    const host = hostMod.createBackendHost({ mode: 'node', token: TOKEN, env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' } });
    (host as unknown as { packManager: unknown }).packManager = ws.manager;
    const tools = (host as unknown as { getFirstRunPackTools(): { install(packPath: string): Promise<{ id: string; version: string }> } | null }).getFirstRunPackTools();
    expect(tools, 'the wrapper is available once the manager exists').not.toBeNull();
    const staged = stageFixture(ws.root, 'bundled-min');
    const result = await tools!.install(staged);
    expect(result).toEqual({ id: 'bundled-min', version: '1.0.0' });
    const envelopes = emitted.filter((e) => e.event === 'pack_install' && e.subject.includes('bundled-min'));
    expect(envelopes.length, 'the bundled-boot install commit must deliver exactly ONE pack_install envelope').toBe(1);
    expectEnvelopeShape(envelopes);
    expect(emitted.length).toBe(1);
  });

  itReal('production-host wiring: createBackendHost threads config.auditSink into the PackManager construction (backend/index.ts:1598, :1203-1208) (audit-desktop-producer)', async () => {
    const { sink } = makeSink();
    const hostMod = await import('../../main/backend/index.js');
    const root = makeTempDir('audit-desktop-wiring-');
    // Minimal VALID production config (c3-pack-wiring precedent: stub engine
    // + hash embedder + a real store path) plus the auditSink under test.
    const host = hostMod.createBackendHost({
      mode: 'node', token: TOKEN, storePath: path.join(root, 'profiles', 'test', 'store.sqlite'), storeEmbeddingDims: 8,
      packsRoot: path.join(root, 'packs'), env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' }, auditSink: sink,
    });
    startedHosts.push(host);
    pmCapture.options.length = 0;
    pmCapture.armed = true;
    try { await host.start(); } finally { pmCapture.armed = false; }
    expect(pmCapture.options.length, 'the production start() path constructed a PackManager (not a harness crash)').toBeGreaterThan(0);
    const captured = pmCapture.options[0] as { auditSink?: unknown };
    expect(captured.auditSink, 'the constructed PackManager auditSink option IS the injected sink object').toBe(sink);
  });

  itReal('multi-version version-less remove: PackManager.remove(packId) deletes several versions in ONE transaction — exactly ONE envelope, subject = the bare packId (pack-manager.ts:715-775) (audit-desktop-producer)', async () => {
    const { emitted, sink } = makeSink();
    const ws = await makeWorkspace(sink);
    const { port } = await startServer(ws.manager);
    for (const fixture of ['versioned-a-1.0.0', 'versioned-a-2.0.0']) {
      const res = await postInstall(port, await zipPackDir(stageFixture(ws.root, fixture)));
      expect(res.status).toBe(200);
    }
    const rowsBefore = await ws.manager.listInstalled();
    expect(rowsBefore.filter((r) => r.packId === 'versioned-a')).toHaveLength(2);
    // NO version: both rows go in ONE transaction. Versioned removes keep
    // the packId@version subject; the version-less multi-row subject is the BARE packId.
    const removed = await ws.manager.remove('versioned-a');
    expect(removed).toBe(2);
    const rowsAfter = await ws.manager.listInstalled();
    expect(rowsAfter.filter((r) => r.packId === 'versioned-a'), 'both versions registry rows are gone').toHaveLength(0);
    const removeEnvelopes = emitted.filter((e) => e.event === 'pack_remove' && e.subject.includes('versioned-a'));
    expect(removeEnvelopes.length, 'the ONE multi-row remove commit delivers exactly ONE pack_remove envelope').toBe(1);
    expect(removeEnvelopes[0]!.subject, 'the version-less multi-row subject is the BARE packId (no @version suffix)').toBe('versioned-a');
    expectEnvelopeShape(emitted);
    expect(emitted.length, 'two install commits + one remove commit = three envelopes').toBe(3);
  });

  itReal('settings-custody composition (outer-commit two-phase): a successful PUT /settings flushes exactly ONE envelope; an outer persist failure AFTER the custody apply rolls back with ZERO (audit-desktop-producer)', async () => {
    // Success: the REAL PUT /settings route over a REAL headless LlamaEngine
    // (no model loads on this path) holding the injected store + rev-4 sink.
    const okStore = makeFakeSecretStore();
    const ok = makeCustodyRecorder();
    const okEngine = new LlamaEngine({ externalProvider: { secretStore: okStore, auditSink: ok.sink } as never });
    const okSrv = await startServer(undefined, { engine: okEngine, persistExternal: () => {} });
    const okRes = await putSettings(okSrv.port, { 'external.apiKey': 'sk-custody-probe-1' });
    expect(okRes.status, 'the outer settings commit succeeded (ok:true)').toBe(200);
    expect([...okStore.map.values()], 'the custody apply really persisted the key in the injected store').toContain('sk-custody-probe-1');
    const okRows = ok.emitted.filter((e) => e.event === 'settings_change' && e.subject.includes('external.apiKey'));
    expect(okRows.length, 'the committed custody save must flush exactly ONE settings_change envelope').toBe(1);
    expectEnvelopeShape(ok.emitted);
    expect(ok.emitted.length, 'exactly one committed custody change: exactly one envelope total').toBe(1);
    // Rollback: the custody apply runs inside apply(), THEN the OUTER
    // persistence fails (injected at the persistSettings seam the route wires
    // from the host's settings.json writer). Buffer must be discarded.
    const rbStore = makeFakeSecretStore();
    const rb = makeCustodyRecorder();
    const rbEngine = new LlamaEngine({ externalProvider: { secretStore: rbStore, auditSink: rb.sink } as never });
    const rbSrv = await startServer(undefined, {
      engine: rbEngine,
      persistSettings: () => {
        throw new Error('settings.json write failed (probe)');
      },
    });
    const rbRes = await putSettings(rbSrv.port, { 'external.apiKey': 'sk-rollback-probe', rag_n_results: 7 });
    expect(rbRes.status, 'the outer persistence failure surfaces as a 500').toBe(500);
    // CONTROL: the store saw the key written; the rollback then removed it.
    expect(rbStore.setHistory, 'the custody apply DID run before the outer failure (non-vacuous control)').toContain('sk-rollback-probe');
    expect([...rbStore.map.values()], 'the rollback restored the SecretStore (key gone)').not.toContain('sk-rollback-probe');
    expect(rb.emitted.length, 'a rolled-back outer commit must deliver ZERO envelopes').toBe(0);
    expect(rb.calls.includes('discard'), 'the rollback DISCARDED the captured custody buffer').toBe(true);
    expect(rb.calls.includes('flush'), 'a rolled-back outer commit never flushes').toBe(false);
  });
});

/**
 * In-memory SecretStore double (the memoryStore() shape); setHistory is the
 * rollback leg's control that the custody apply really ran before the outer
 * failure. Key values are asserted by CONTAINMENT, never by entry name.
 */
function makeFakeSecretStore() {
  const map = new Map<string, string>();
  const setHistory: string[] = [];
  return {
    map,
    setHistory,
    persistent: true,
    get: (name: string) => map.get(name) ?? null,
    set: (name: string, value: string) => { map.set(name, value); setHistory.push(value); },
    delete: (name: string) => { map.delete(name); },
  };
}

/** Rev-4 custody sink double: capture buffers, flush delivers, discard drops. */
function makeCustodyRecorder() {
  const emitted: DesktopAuditEnvelope[] = [];
  const pending: DesktopAuditEnvelope[] = [];
  const calls: string[] = [];
  return {
    emitted,
    calls,
    sink: {
      capture: (envelope: DesktopAuditEnvelope) => { calls.push('capture'); pending.push({ ...envelope }); },
      flush: () => { calls.push('flush'); emitted.push(...pending.splice(0)); },
      discard: () => { calls.push('discard'); pending.length = 0; },
    },
  };
}
