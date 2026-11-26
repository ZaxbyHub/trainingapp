// frozen-check C4 companion, rev 6 (critic Round-5 R5-6 + R5-5 wave-5, then
// Round-6 R6-5 wave-6 amendment: SENDER-SET bind semantics) — #373 AC1 roster
// extension over audit-desktop-producer.test.ts (that file keeps its 8 legs
// byte-equivalent; the legs here carry the production-composition /
// post-COMMIT-push + sender-set-bind / custody-clear roster; the R6-4
// engineOverrides production-composition legs live in the third frozen file
// audit-outbox-production.test.ts — same driver, all three run):
//   (8) the REAL production composition — buildProductionBackendHostConfig
//       (desktop/main/backend-config.ts, extracted from the inline config at
//       desktop/main/index.ts:426-477) → the REAL createBackendHost
//       (backend/index.ts:1598) → the host's PackManager construction
//       (backend/index.ts:1203-1208) receiving the BUILT auditSink (Object.is);
//   (9) the post-COMMIT push — a REAL install through the production sink
//       appends IN-TX to the real audit_outbox SQLite table and registers a
//       ONE-SHOT after-commit callback (PackManager.inTransaction queue,
//       pack-manager.ts:1511-1526) that fires ONLY after COMMIT returns and
//       notifies { generation, pendingCount } — proven after-COMMIT (not
//       merely after-emit) because the notify spy's fresh read runs on a
//       SEPARATE connection, which in WAL mode (sqlite-store.ts:194-196)
//       sees only committed rows — PLUS the R6-5 SENDER-SET bind semantics
//       (two same-prefix senders share ONE generation; a foreign sender is
//       rejected);
//   (10) the successful API-key CLEAR custody route — PUT /settings
//       { 'external.apiKey': '' } → ok → EXACTLY ONE settings_change envelope
//       whose subject names the cleared key (the SAME external.apiKey subject
//       the C4 save leg asserts; one envelope per committed custody change),
//       the REAL clearKey path removing the key from the store
//       (external-provider.ts:317-321 → :426-430), and a FAILED clear (outer
//       persist failure) yielding ZERO envelopes for the clear.
//
// FROZEN SPEC — authored by the independent check author at base
// 54107572c092febc00beff17f719ff631a2215ac, before any implementation
// exists; the implementer makes it pass WITHOUT editing it (canonical copy:
// the issue trace at frozen/desktop/src/__tests__). RED at base (vitest's
// file-absent signature: `No test files found`), GREEN after the fix.
// Dropped into the pre-fix tree every leg fails at an ASSERTION (per-leg
// dynamic imports of the NEW-SURFACE modules, so a missing module is never a
// collection error): the composition leg at the backend-config module /
// captured-auditSink assertion; the push leg at the audit-outbox module /
// outbox-row / notify / sender-set assertions; the clear leg at its
// envelope-count assertion while the REAL clearKey store effect asserts
// true first.
//
// Harness contract (declared for the implementer — plan Part 4 v7 items 3,
// 4, 5; the NEW-SURFACE names are DECLARED HERE pre-implementation and the
// implementation binds to them):
//   1. desktop/main/backend-config.ts exports
//      buildProductionBackendHostConfig(opts): BackendHostConfig — PURE
//      (callbacks injected, no Electron imports); opts carry every
//      index.ts:426-477 field (token, tokenHeaderName, allowedOrigins, mode,
//      engine, storePath, packsRoot, storeBackupsDir, onIngestProgress,
//      onMemoryEvent, onStoreCorruption, onGiveUp) plus auditSink, and pass
//      through the BackendHostConfig knobs a minimal valid host needs
//      (storeEmbeddingDims, env).
//   2. desktop/main/backend/audit-outbox.ts exports
//      createProductionAuditSink(getStore, notify): { emit(envelope): void }
//      — emit appends IN-TX to the real audit_outbox table on the CURRENT
//      store resolved from getStore (appendInTx(currentStore.db, …): same
//      connection, so rollback takes the envelope) AND registers a ONE-SHOT
//      after-commit callback on the inTransaction queue that fires only
//      after COMMIT returns and calls notify({ generation, pendingCount }),
//      generation = the CURRENT binding generation, pendingCount = the
//      pending rows observable after this commit's append; and
//      bindOutboxBinding(store, prefix, sender?): Promise<{ prefix,
//      generation }> — the Part-4-item-5 bind API with SENDER-SET semantics
//      (R6-5): same prefix → SAME generation, the sender APPENDED to the
//      authorized set (a shared same-tab lease is representable); different
//      prefix → rebind (new generation, senders = [sender]); invalidation
//      clears the set. Generation-checked pending/ack (the bridge-call
//      class): readOutboxPending(store, generation, sender) and
//      ackOutboxEvent(store, generation, sender, eventId) validate the
//      generation matches AND the sender ∈ set — a foreign sender (correct
//      generation) or a stale generation is REJECTED with an error naming
//      the sender/generation; ack resolves true iff its row was deleted.
//   3. audit_outbox columns (plan Part 4 item 1): event_id (PK), seq, event,
//      subject, occurred_at.
//   4. DesktopAuditEnvelope and the custody two-phase sink (capture/flush/
//      discard bound to the OUTER settings commit) are the SAME shapes frozen
//      C4 declares; this spec reuses them verbatim.
import { afterEach, describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

// Construction capture for the composition leg: a faithful subclass around
// the REAL PackManager export (identical behavior elsewhere; while armed it
// records the options production passed to the constructor — wave-4 pattern).
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
const itReal = nativeDepsIt('audit-outbox-composition');
const TOKEN = 'audit-outbox-composition-token';
const TOKEN_HEADER = 'x-desktop-token';

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
const openServers: http.Server[] = [];
const startedHosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (startedHosts.length > 0) await startedHosts.pop()!.stop().catch(() => undefined);
  for (const server of openServers.splice(0)) { try { server.close(); } catch { /* closed */ } }
  for (const store of openStores.splice(0)) { try { store.close(); } catch { /* closed */ } }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir;
}

/** The declared delivery-seam payload (frozen C4's harness contract). */
interface DesktopAuditEnvelope {
  eventId: string;
  event: 'pack_install' | 'pack_remove' | 'settings_change';
  subject: string;
  occurredAt: number;
}

/** Recording sink: this spec's observer at the declared producer seam. */
function makeSink(): { emitted: DesktopAuditEnvelope[]; sink: { emit(envelope: DesktopAuditEnvelope): void } } {
  const emitted: DesktopAuditEnvelope[] = [];
  return { emitted, sink: { emit(envelope: DesktopAuditEnvelope): void { emitted.push({ ...envelope }); } } };
}

/** Declared NEW-SURFACE contract of desktop/main/backend/audit-outbox.ts. */
interface OutboxAccess {
  createProductionAuditSink(
    getStore: () => { db: unknown } | null,
    notify: (payload: { generation: number; pendingCount: number }) => void,
  ): { emit(envelope: DesktopAuditEnvelope): void };
  bindOutboxBinding(store: { db: unknown }, prefix: string, sender?: number): Promise<{ prefix: string; generation: number }>;
  readOutboxPending(store: { db: unknown }, generation: number, sender: number): Promise<OutboxRow[]>;
  ackOutboxEvent(store: { db: unknown }, generation: number, sender: number, eventId: string): Promise<boolean>;
}

/** Declared NEW-SURFACE contract of desktop/main/backend-config.ts. */
interface BackendConfigModule {
  buildProductionBackendHostConfig(opts: Record<string, unknown>): Record<string, unknown>;
}

/** One row of the real audit_outbox table (plan Part 4 item 1 columns). */
interface OutboxRow { event_id: string; seq: number; event: string; subject: string; occurred_at: number }

// The native addon loads lazily INSIDE the gated legs (#193 D2 discipline —
// a top-level require would defeat the native-deps skip gate).
const requireNative = createRequire(import.meta.url);

/**
 * Read audit_outbox on a BRAND-NEW SEPARATE connection. In WAL mode
 * (sqlite-store.ts:194-196) another connection sees only COMMITTED rows —
 * a row visible here proves COMMIT happened; the workspace's own handle
 * would also see uncommitted in-tx appends and prove nothing.
 */
function readOutboxOnFreshConnection(dbPath: string): { rows: OutboxRow[]; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { all(): unknown[] }; close(): void };
    const conn = new Database(dbPath);
    try {
      const rows = conn.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox').all() as OutboxRow[];
      return { rows, error: null };
    } finally {
      conn.close();
    }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** A real SQLite workspace handle opened the way the pack lifecycle does. */
async function openWorkspaceStore(): Promise<{ root: string; dbPath: string; store: { db: unknown; close(): void } }> {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const root = makeTempDir('audit-outbox-composition-');
  const dbPath = path.join(root, 'store.db');
  const store = storeMod.openStore({ dbPath, dims: 8 });
  openStores.push(store);
  return { root, dbPath, store };
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

async function postInstall(port: number, zip: Uint8Array): Promise<Response> {
  const boundary = 'auditoutboxcomposition';
  return fetch(`http://127.0.0.1:${port}/packs/install`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: buildMultipartBody(boundary, 'pack.zip', zip),
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
    expect(envelope.subject.length, 'the subject is a stable id, never empty').toBeGreaterThan(0);
    expect(typeof envelope.occurredAt).toBe('number');
    expect(envelope.occurredAt).toBeGreaterThan(0);
  }
  const ids = new Set(envelopes.map((e) => e.eventId));
  expect(ids.size, 'no two commits share an eventId (no duplicate rows per commit)').toBe(envelopes.length);
}

/**
 * In-memory SecretStore double (the memoryStore() shape). setHistory /
 * deleteHistory are the non-vacuous controls that the custody apply and the
 * real clearKey really ran. Key values are asserted by CONTAINMENT only.
 */
function makeFakeSecretStore() {
  const map = new Map<string, string>();
  const setHistory: string[] = [];
  const deleteHistory: string[] = [];
  return {
    map,
    setHistory,
    deleteHistory,
    persistent: true,
    get: (name: string) => map.get(name) ?? null,
    set: (name: string, value: string) => { map.set(name, value); setHistory.push(value); },
    delete: (name: string) => { deleteHistory.push(name); map.delete(name); },
  };
}

/** Custody sink double (frozen C4's rev-4 two-phase shape): capture buffers, flush delivers, discard drops. */
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

describe('audit-outbox-composition: production wiring, post-COMMIT push, custody clear (#373 AC1 — R5-6/R5-5)', () => {
  itReal('production composition: the REAL buildProductionBackendHostConfig (backend-config.ts, extracted from index.ts:426-477) feeds the REAL createBackendHost whose PackManager receives the built auditSink (backend/index.ts:1598, :1203-1208) (audit-outbox-composition)', async () => {
    const configMod = (await import('../../main/backend-config.js').catch(() => null)) as unknown as BackendConfigModule | null;
    expect(configMod, 'the production config builder desktop/main/backend-config.ts must exist (plan Part 4 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof configMod!.buildProductionBackendHostConfig, 'the builder export has the declared name buildProductionBackendHostConfig').toBe('function');
    const { sink } = makeSink();
    const engineMod = await import('../../main/backend/engine.js');
    const stubEngine = new engineMod.StubEngine();
    const root = makeTempDir('audit-outbox-builder-');
    const storePath = path.join(root, 'profiles', 'test', 'store.sqlite');
    const onIngestProgress = (): void => {};
    const onMemoryEvent = (): void => {};
    const onStoreCorruption = async (): Promise<'fresh'> => 'fresh';
    const onGiveUp = (): void => {};
    // The builder receives the FULL production field set the inline object at
    // index.ts:426-477 carries, plus the auditSink under test and the
    // minimal-valid knobs wave-4's wiring leg proved (stub engine env, hash
    // embedder env, 8 dims, a real store path).
    const built = configMod!.buildProductionBackendHostConfig({
      token: TOKEN,
      tokenHeaderName: TOKEN_HEADER,
      allowedOrigins: ['http://127.0.0.1:5173'],
      mode: 'node',
      engine: stubEngine,
      storePath,
      packsRoot: path.join(root, 'packs'),
      storeBackupsDir: path.join(root, 'backups'),
      storeEmbeddingDims: 8,
      env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      onIngestProgress,
      onMemoryEvent,
      onStoreCorruption,
      onGiveUp,
      auditSink: sink,
    });
    // The builder output preserves the production fields the inline object carries.
    expect(built.token).toBe(TOKEN);
    expect(built.tokenHeaderName).toBe(TOKEN_HEADER);
    expect(built.allowedOrigins).toEqual(['http://127.0.0.1:5173']);
    expect(built.mode).toBe('node');
    expect(built.engine, 'the resolved engine is the injected one (Object.is)').toBe(stubEngine);
    expect(built.storePath, 'the per-profile store path survives the extraction').toBe(storePath);
    expect(built.packsRoot).toBe(path.join(root, 'packs'));
    expect(built.storeBackupsDir).toBe(path.join(root, 'backups'));
    expect(built.onIngestProgress).toBe(onIngestProgress);
    expect(built.onMemoryEvent).toBe(onMemoryEvent);
    expect(built.onStoreCorruption).toBe(onStoreCorruption);
    expect(built.onGiveUp).toBe(onGiveUp);
    expect(built.auditSink, 'the builder output carries the injected sink (Object.is)').toBe(sink);
    // The REAL host built FROM THE BUILDER OUTPUT (the only config object
    // handed to createBackendHost — no inline construction) threads the sink.
    const hostMod = await import('../../main/backend/index.js');
    const host = hostMod.createBackendHost(built as Parameters<typeof hostMod.createBackendHost>[0]);
    startedHosts.push(host);
    pmCapture.options.length = 0;
    pmCapture.armed = true;
    try { await host.start(); } finally { pmCapture.armed = false; }
    expect(pmCapture.options.length, 'the production start() path constructed a PackManager from the BUILT config (not a harness crash)').toBeGreaterThan(0);
    const captured = pmCapture.options[0] as { auditSink?: unknown };
    expect(captured.auditSink, 'builder → createBackendHost → PackManager construction: the captured auditSink IS the sink object the config was built with (Object.is)').toBe(sink);
  });

  itReal('after-commit push + sender-set binding: a REAL install through the production sink appends in-tx, notifies EXACTLY ONCE AFTER COMMIT with { generation, pendingCount }, and TWO same-prefix senders share ONE generation while a FOREIGN sender is REJECTED (pack-manager.ts:1511-1526) (audit-outbox-composition)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as OutboxAccess | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 items 1-3, 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    // R6-5 sender-set bind: same prefix → SAME generation, sender APPENDED.
    const { root, dbPath, store } = await openWorkspaceStore();
    const bindingOne = await outboxMod!.bindOutboxBinding(store, 'audit-composition-prefix', 101);
    const bindingTwo = await outboxMod!.bindOutboxBinding(store, 'audit-composition-prefix', 202);
    expect(bindingOne.generation, 'the bind API returns a positive monotonic generation').toBeGreaterThan(0);
    expect(bindingTwo.generation, 'TWO same-prefix subscriptions (distinct sender ids) share the SAME generation — the sender is APPENDED to the authorized set, the lease is NOT rebound (R6-5)').toBe(bindingOne.generation);
    // The production sink: emit appends in-tx and registers a one-shot
    // after-commit notify. The spy's fresh read runs on a SEPARATE connection
    // so row visibility at notify time proves COMMIT already returned.
    const notifyCalls: Array<{ payload: { generation: number; pendingCount: number }; rowVisibleOnFreshConnection: boolean; freshReadError: string | null }> = [];
    const notify = (payload: { generation: number; pendingCount: number }): void => {
      const observed = readOutboxOnFreshConnection(dbPath);
      notifyCalls.push({
        payload: { ...payload },
        rowVisibleOnFreshConnection: observed.rows.some((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min')),
        freshReadError: observed.error,
      });
    };
    const productionSink = outboxMod!.createProductionAuditSink(() => store, notify);
    const managerMod = await import('../../main/backend/store/pack-manager.js');
    const embedderMod = await import('../../main/backend/ingest/embedder.js');
    const manager = new managerMod.PackManager({
      store,
      embedder: new embedderMod.HashEmbedder({ dims: 8 }),
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
      packsSecurity: { embeddingModelId: 'hash-test' },
      auditSink: productionSink,
    });
    const { port } = await startServer(manager);
    const staged = stageFixture(root, 'bundled-min');
    const installRes = await postInstall(port, await zipPackDir(staged));
    expect(installRes.status, 'the REAL install route committed').toBe(200);
    // (1) The durable row: the real audit_outbox table, read on a SEPARATE connection.
    const finalRead = readOutboxOnFreshConnection(dbPath);
    expect(finalRead.error, 'the audit_outbox table exists and reads cleanly after the commit').toBeNull();
    const installRows = finalRead.rows.filter((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min'));
    expect(installRows.length, 'the committed install appended EXACTLY ONE durable row to the real audit_outbox table').toBe(1);
    expect(installRows[0]!.event_id.length, 'the durable row carries a non-empty event_id (the PK/dedup key)').toBeGreaterThan(0);
    expect(typeof installRows[0]!.seq, 'the durable row carries the allocated seq').toBe('number');
    expect(installRows[0]!.occurred_at, 'the durable row carries a positive occurred_at').toBeGreaterThan(0);
    // (2) The push: exactly once, with the BOUND generation, AFTER the row was observable.
    expect(notifyCalls.length, 'the after-commit push fired EXACTLY ONCE for the single committed install (one-shot callback)').toBe(1);
    const call = notifyCalls[0]!;
    expect(call.payload, 'the push payload is exactly { generation, pendingCount } with the BOUND generation').toEqual({ generation: bindingOne.generation, pendingCount: 1 });
    expect(call.freshReadError, 'the notify-time fresh read on a separate connection succeeded').toBeNull();
    expect(call.rowVisibleOnFreshConnection, 'AT NOTIFY TIME a fresh read on a SEPARATE connection already saw the committed row — the push is AFTER COMMIT, not merely after-emit').toBe(true);
    // (3) R6-5 sender-set validation: BOTH authorized senders pass the
    // generation+sender gate on a pending call (the ack-class check every
    // bridge call carries) — the rejection probes run FIRST, while the row
    // still exists, so ONLY the sender gate can explain them.
    const pendingOne = await outboxMod!.readOutboxPending(store, bindingOne.generation, 101);
    expect(pendingOne.map((r) => r.event_id), 'authorized sender 101 sees the committed row as pending').toContain(installRows[0]!.event_id);
    const pendingTwo = await outboxMod!.readOutboxPending(store, bindingOne.generation, 202);
    expect(pendingTwo.map((r) => r.event_id), 'authorized sender 202 (same prefix, SAME generation) sees the SAME pending row — the shared lease is real').toContain(installRows[0]!.event_id);
    await expect(outboxMod!.readOutboxPending(store, bindingOne.generation, 333), 'a FOREIGN sender with the CORRECT generation is REJECTED at the pending gate (sender ∈ set is validated independently of the generation match)').rejects.toThrow(/sender/i);
    await expect(outboxMod!.ackOutboxEvent(store, bindingOne.generation, 333, installRows[0]!.event_id), 'a FOREIGN sender\'s ACK is REJECTED too — it must not consume the pending row').rejects.toThrow(/sender/i);
    await expect(outboxMod!.ackOutboxEvent(store, bindingOne.generation, 202, installRows[0]!.event_id), 'the second same-prefix sender\'s ACK is ACCEPTED (sender ∈ authorized set, generation matches) and deletes the row').resolves.toBe(true);
  });

  itReal('custody clear: PUT /settings { "external.apiKey": "" } commits ok — exactly one settings_change envelope naming the cleared key; the REAL clearKey removes it; a FAILED clear yields zero (external-provider.ts:317-321, :426-430) (audit-outbox-composition)', async () => {
    // Success path: the REAL PUT /settings route over a REAL headless
    // LlamaEngine holding the injected store + the two-phase custody sink.
    const okStore = makeFakeSecretStore();
    const ok = makeCustodyRecorder();
    const okEngine = new LlamaEngine({ externalProvider: { secretStore: okStore, auditSink: ok.sink } as never });
    const okSrv = await startServer(undefined, { engine: okEngine, persistExternal: () => {} });
    const saveRes = await putSettings(okSrv.port, { 'external.apiKey': 'sk-clear-probe-1' });
    expect(saveRes.status, 'the arrange SAVE commit succeeded').toBe(200);
    expect([...okStore.map.values()], 'the arrange save really persisted the key in the injected store').toContain('sk-clear-probe-1');
    const deletesAfterSave = okStore.deleteHistory.length;
    // THE CLEAR: '' through the REAL route → apply (:317-321) → the REAL
    // clearKey (:426-430) — never a hand-rolled clear.
    const clearRes = await putSettings(okSrv.port, { 'external.apiKey': '' });
    expect(clearRes.status, 'the outer settings commit for the CLEAR succeeded (ok)').toBe(200);
    expect([...okStore.map.values()], 'the REAL clearKey path removed the key from the store (external-provider.ts:426-430)').not.toContain('sk-clear-probe-1');
    expect(okStore.deleteHistory.length, 'the clear drove real SecretStore DELETEs (clearKey, not a hand-rolled clear)').toBeGreaterThan(deletesAfterSave);
    // Envelope contract: the CLEAR's subject is the SAME external.apiKey key
    // the C4 save leg asserts; one envelope per committed custody change.
    const custodyRows = ok.emitted.filter((e) => e.event === 'settings_change' && e.subject.includes('external.apiKey'));
    expect(custodyRows.length, 'save + clear = EXACTLY ONE settings_change envelope per committed custody change (the clear subject names the cleared key)').toBe(2);
    expect(ok.emitted.length, 'no other envelopes: exactly two committed custody changes total').toBe(2);
    expectEnvelopeShape(custodyRows);
    expect(ok.calls.includes('flush'), 'the successful clear FLUSHED (outer commit ok)').toBe(true);
    // Failed clear: the custody clear runs inside apply(), THEN the OUTER
    // external persistence fails (injected at the persistExternal seam — an
    // external-only patch writes external.json, not settings.json). The
    // captured buffer must be discarded: ZERO envelopes for the clear.
    const rbStore = makeFakeSecretStore();
    const rb = makeCustodyRecorder();
    const rbEngine = new LlamaEngine({ externalProvider: { secretStore: rbStore, auditSink: rb.sink } as never });
    let externalPersists = 0;
    const rbSrv = await startServer(undefined, {
      engine: rbEngine,
      persistExternal: () => { externalPersists += 1; if (externalPersists > 1) throw new Error('external.json write failed (clear probe)'); },
    });
    const rbSaveRes = await putSettings(rbSrv.port, { 'external.apiKey': 'sk-clear-probe-2' });
    expect(rbSaveRes.status, 'the arrange save succeeded (first external persist ok)').toBe(200);
    const rbDeletesAfterSave = rbStore.deleteHistory.length;
    const rbClearRes = await putSettings(rbSrv.port, { 'external.apiKey': '' });
    expect(rbClearRes.status, 'the outer persistence failure surfaces as a 500 (the clear applied, then rolled back)').toBe(500);
    expect(rbStore.deleteHistory.length, 'clearKey DID run inside the failed clear (non-vacuous control)').toBeGreaterThan(rbDeletesAfterSave);
    expect([...rbStore.map.values()], 'the rollback restored the key the clear removed').toContain('sk-clear-probe-2');
    const rbRows = rb.emitted.filter((e) => e.event === 'settings_change');
    expect(rbRows.length, 'a FAILED clear (outer persist failure) delivers ZERO envelopes for the clear (only the arrange save\'s one)').toBe(1);
    expect(rb.calls.includes('discard'), 'the failed clear DISCARDED the captured custody buffer').toBe(true);
  });
});
