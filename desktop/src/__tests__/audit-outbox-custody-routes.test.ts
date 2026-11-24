// audit-outbox-custody-routes.test.ts — frozen check C4 (the desktop half of
// #373: settings custody routes and the first-run registration), rev 17 (plan
// Part 4 v27).
//
// What this file proves, EXECUTABLY: the shipped-caller BOOTSTRAP (the REAL
// desktop/main/index.ts whenReady callback under the desktop electron stub, with
// a production-faithful engine injection, a hermetic fast→quality TRANSITION,
// REAL pack install/remove through the captured manager, and the external.apiKey
// custody commit), request-threaded custody under the settings-commit MUTEX in
// both orders with request-arrival barriers, applyEngineSettings ordering, the
// first-run AWAIT and REGISTRATION legs through the REAL Electron signature (the
// inference-only patch re-scoped per R14-1), and the legacy-sink adapter with two
// sequential real PUTs.
//
// RED at base, for the right reason: the module legs fail at their first
// module-absence assertion (catch → null — audit-outbox.ts and complete-handler.ts
// are absent); the BOOTSTRAP leg fails at its startup-sink assertion — the
// createBackendHost config must carry the startup-built audit sink, which the
// pre-fix wiring does not provide (a desktop:first-run:complete registration
// DOES exist at base: index.ts registers it inline); the source-level pin
// (the last test) fails at its module-bound import assertion (the pre-fix index.ts
// holds ZERO registerFirstRunCompleteIpc references; the finder fails closed on
// wrong-module and unresolved-module shapes).
//
// Declared here (the assertion messages cite these numbers):
//   22. desktop/main/backend/audit-outbox.ts exports adaptLegacyCustodySink(sink) —
//       the legacy-sink adapter: "the factory accepts EITHER beginRequest() sinks
//       OR a plain { capture, flush, discard } object" (the plan does not name it;
//       this spec binds the name).
// "Header item 2" / "production file header item 2" in the messages of this file
// is the companion production spec harness-contract item 2 (the same audit-outbox.ts
// contract); items 25-30 are below.
//
// CHECK_WRONG rev 17 (Phase 4 execution): two concurrency legs used public
// HTTP fixture URLs with airgap=true (the shipped policy correctly returned
// 422 before capture, so their arrival barriers timed out); they now use
// HTTPS with airgap=false. The legacy end-to-end sink was stateful across
// requests (one spent provider batch); it now acquires a fresh batch per
// flush. No assertion or product policy was weakened.
// Harness contract (declared for the implementer — plan Part 4 v15 item 3;
// where the plan names only semantics, THIS spec binds the names):
//   25. (rev 2, R11-5) desktop/main/first-run/complete-handler.ts (new,
//       declared) exports buildFirstRunCompleteHandler(deps) — the EXTRACTED
//       'desktop:first-run:complete' handler body, where deps are the real
//       handler's collaborators at index.ts:1035-1113:
//         interface FirstRunCompleteDeps {
//           // the :1063-1087 completion gates + saveFirstRunState,
//           // collapsed to ONE injected step: resolves when completion is
//           // persisted; THROWS to refuse (the WizardBlockError refusal arm)
//           completeWizard(payload: { selectedProfile: 'quality' | 'fast';
//                                    acknowledgedLicenses: boolean }):
//             Promise<void> | void;
//           // the :1093-1095 engine seam — the handler AWAITS this call's
//           // result BEFORE branching on .ok, with the caller's exact patch
//           // { 'inference.profile': selectedProfile }
//           backendHost: { applyEngineSettings?: (patch: Record<string, unknown>) =>
//             Promise<{ ok: true } | { ok: false; status: number; detail: string }> |
//             { ok: true } | { ok: false; status: number; detail: string } } | null | undefined;
//           // the :1101-1105 warmup (runs ONLY on the .ok success branch)
//           engine: { warmup?: () => void | Promise<void> };
//         }
//         buildFirstRunCompleteHandler(deps): (payload: unknown) =>
//           Promise<{ ok: true } | { ok: false; detail: string; reason?: string }>;
//       The handler validates the payload exactly as index.ts does
//       (selectedProfile must be 'quality' | 'fast', else
//       { ok: false, detail, reason: 'profile-not-selected' } before any
//       engine work; acknowledgedLicenses === true feeds completeWizard).
//   25b. (rev 3, R12-2) desktop/main/first-run/complete-handler.ts ALSO
//       exports registerFirstRunCompleteIpc(
//         ipc: { handle(channel: string, callback: unknown): void },
//         deps: FirstRunCompleteDeps): void
//       — the EXTRACTED registration: it CALLS buildFirstRunCompleteHandler(
//       deps) and registers the RESULTING HANDLER via
//       ipc.handle('desktop:first-run:complete', handler) itself (registering
//       the factory UNCALLED — ipc.handle(ch, buildFirstRunCompleteHandler)
//       with ZERO factory calls — is the R12-2 uncalled-factory mutant and
//       fails the registration leg's captured-callback identity assertion).
//       index.ts performs exactly ONE live direct
//       registerFirstRunCompleteIpc(ipcMain, deps) call (inside the
//       whenReady startup path) and retains NO residual inline
//       ipcMain.handle('desktop:first-run:complete', ...) closure.
//       (rev 4, R13-3) the registration ADAPTS the REAL Electron handler
//       signature: ipcMain.handle invokes its callback as (event, ...args),
//       so registerFirstRunCompleteIpc registers an EXPLICIT adapter —
//       ipc.handle('desktop:first-run:complete', (_event, payload) =>
//       handler(payload)) — OR declares the extracted handler itself with
//       the real two-argument signature. A one-argument (payload) product
//       registered DIRECTLY receives the event object as payload (the
//       preload's ipcRenderer.invoke(channel, payload) requests would all
//       be refused profile-not-selected) and fails every
//       captured(null, payload) leg below.
//   26. (rev 3, R12-4) NEW-SURFACE optional TEST SEAM onSettingsSectionEntry:
//       BOTH createBackendServer's options and createBackendHost's config
//       accept onSettingsSectionEntry?: (section: { patch:
//       Record<string, unknown> }) => void — a callback that fires
//       SYNCHRONOUSLY the moment a settings commit section is ENTERED
//       (before awaiting the settings-commit mutex), carrying the incoming
//       patch so a test can identify WHICH request arrived. Production
//       implements it as an optional callback with default undefined and
//       ZERO behavior when absent — no logging, no persistence, nothing but
//       the call. applyEngineSettings sections fire the SAME seam (the host
//       config's copy), because the ONE settings-commit mutex covers every
//       outer caller (PUT patch, PUT reset, applyEngineSettings, and the
//       first-run handler).
//   27. (rev 5, R14-1 + R14-2 — plan Part 4 v15 item 3) the production
//       first-run patch `{'inference.profile': selectedProfile}` NEVER
//       enters the ExternalProviderState custody capture (batch.capture
//       threads exclusively into external save/clear/reset) and emits NO
//       envelope BY DESIGN — no frozen leg asserts a custody row, flush, or
//       discard for that patch. The first-run await contract is the
//       DEFERRED proof: while the injected applyEngineSettings result is
//       pending, the handler has not warmed up and has not resolved; the
//       warmup fires strictly after the deferred resolves. The INDEX-
//       SUPPLIED custody chain is proven ONLY through an `external.apiKey`
//       commit against the CAPTURED bootstrap-built host (exactly one
//       durable settings_change row on a fresh connection of the host's
//       own store), and the shipped STARTUP pack sink is proven ONLY by
//       REAL install/remove commits through the CAPTURED bootstrap-built
//       PackManager landing exactly one durable envelope per commit on a
//       fresh connection of that same store — an index-level override of
//       the startup sink with a no-op `{ emit() {} }` produces zero
//       envelopes and FAILS those assertions (presence of an emit function
//       is not evidence).
//   28. (rev 6, R15-1 — plan Part 4 v16 item 3) TEST-SIDE ENGINE-INJECTION
//       SEAM, bootstrap leg ONLY: the leg's EXISTING vi.mock of
//       backend/index.js (the passthrough createBackendHost recorder) ALSO
//       wraps `resolveNodeEngine` — while `armed`, a call whose env carries
//       TRAININGAPP_DESKTOP_ENGINE='stub' (the e1 recipe's env) does NOT
//       return the StubEngine short-circuit product; it constructs a REAL
//       `new LlamaEngine(indexSuppliedOptions)` mirroring the NON-STUB
//       construction at llama-engine.ts:847-857 with the SAME index-supplied
//       options (modelDir, userDataPath, models, externalProvider,
//       gpuVerdict, onGpuLoadFailure, gpuVerdictDir, profile, threads —
//       whatever the REAL index passed, including any startup-built custody
//       sink inside externalProvider). The constructed instance's warmup is
//       SPIED: invocation recorded, model-load side effect ABSENT
//       (production's call site fire-and-forgets
//       `void engine.warmup?.().catch(() => {})`, index.ts:1101-1105).
//       PRODUCTION IS UNCHANGED: engine-selection semantics, StubEngine,
//       and the real resolveNodeEngine keep their shipped contracts — the
//       interception exists ONLY inside THIS frozen spec (its owning file);
//       every other leg of this file and every other spec delegates to the
//       real export untouched, and no existing engine/StubEngine test is
//       affected. The bootstrap leg's assertions are STRENGTHENED, never
//       deleted: the real-engine identity (instanceof LlamaEngine, NOT
//       StubEngine), first-run result.ok === true AND ACTUAL acceptance of
//       the inference patch (captureSettingsState().profileSetting ===
//       selectedProfile) AND warmup invoked, and the external.apiKey
//       commit's ok:true + exactly-one durable settings_change row through
//       the index-supplied sink.
//   29. (rev 7, R16-2 — plan Part 4 v17 item 3) HERMETIC PROFILE ENV +
//       BEFORE/AFTER TRANSITION, bootstrap leg ONLY: the bootstrap env
//       roster saves/clears/restores TRAININGAPP_DESKTOP_INFERENCE_PROFILE
//       with the other ENV_KEYS (an inherited value can no longer pre-satisfy
//       the acceptance predicate — the executed 06 :1296-1302 stale-quality
//       FALSE-GREEN) and EXPLICITLY arranges the NON-quality startup profile
//       'fast' before bootstrap(); the mocked resolver (item 28) derives
//       profile 'fast' from that env exactly as resolveNodeEngine would
//       (llama-engine.ts:842-845; the ordinary default is 'auto',
//       llama-engine.ts:969-974). BEFORE the captured first-run callback is
//       invoked, the constructed engine's captureSettingsState()
//       .profileSetting is asserted === 'fast' (NOT already 'quality'); AFTER
//       the callback the exact TRANSITION to 'quality' is required plus
//       warmup invoked — an implementation that drops/ignores the
//       `inference.profile` patch while returning a successful apply result
//       cannot satisfy the transition. The engine-identity, external
//       ok:true/durable-row, and nonfatal controlled-failure assertions of
//       items 25-28 are unchanged.
//   30. (rev 17 — plan Part 4 v27 items 3-4) THE EXACTLY-ONCE CLAIM for the
//       shipped registration, scoped to what a check can verify exactly:
//       (a) EXECUTED EFFECT — the BOOTSTRAP leg (FIRST in the describe) runs the
//           REAL desktop/main/index.ts bootstrap with the first-run and
//           backend-config modules UNMOCKED, asserts EXACTLY ONE live registration
//           of desktop:first-run:complete on the recording ipcMain.handle, and
//           invokes that captured callback as captured(null, payload) — the REAL
//           Electron (event, payload) signature. A second registration, or none,
//           fails there.
//       (b) SOURCE-LEVEL PIN (the last test of this file) — index.ts statically
//           imports registerFirstRunCompleteIpc from the EXACT module
//           desktop/main/first-run/complete-handler.ts (module-bound existence —
//           R13-2; wrong-module and unresolved-module shapes FAIL CLOSED), and the
//           SOURCE CENSUS: the name occurs as a USAGE (an identifier outside
//           import/export binding positions, or a whole string literal equal to the
//           name) EXACTLY ONCE across every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs
//           file of the repository outside node_modules, .git, .agents, dist, out,
//           build, coverage, __tests__, tests, test, and e2e — the defining module
//           excluded — and that one usage is a DIRECT CALL in index.ts.
//       NOT CLAIMED, by design: (i) an invocation of the underlying function
//       synthesized at RUNTIME by dynamic code evaluation or by a separately
//       loaded module instance; (ii) a usage of the name spelled under ANOTHER
//       NAME — an aliased import of the target, or an alias export of the defining
//       module called elsewhere (the census is a census of the literal spelling
//       and does not resolve aliases); (iii) REACHABILITY — the source pin is
//       SYNTACTIC, so a call present in the text but dead (e.g. under `if (false)`)
//       still passes it. No acceptance criterion of #372 or #373 requires any of
//       those, so none is a check concern — the implementation diff is reviewed
//       in Phase 4.5/4.6. The rev 12-13 counting spies and the rev 13 mechanism
//       gate are RETIRED WITH their machinery (06 Rounds 12-22: every "no
//       invocation by any mechanism" claim was one more executed shape away from
//       false).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { app, ipcMain } from 'electron';
import * as electronModule from 'electron';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';
/** The desktop electron stub's reset — NOT part of the real Electron surface, so it is reached through a narrowed namespace view: desktop/vitest.config.ts aliases the bare 'electron' specifier to desktop/test/electron-stub.ts for every import in the suite, and THAT module exports __resetElectronStub (the e1-packaged-glue-hardening beforeEach reset; the stub is file-fresh here, the reset is belt-only). */
const resetElectronStub = (electronModule as typeof electronModule & { __resetElectronStub?: () => void }).__resetElectronStub;

// Construction capture for the rev-4 shipped-caller BOOTSTRAP leg (R13-1/
// R13-3 fundamental proof; the e1-packaged-glue-hardening passthrough-
// recorder pattern around resolveNodeEngine, here around createBackendHost):
// the wrapper records the config production passed to the constructor and
// otherwise delegates to the REAL export unchanged, so every other leg in
// this file keeps its behavior (the mutex/applyEngineSettings legs construct
// their hosts through the same passthrough). Rev 5 (R14-1/R14-2): the
// wrapper ALSO records the CONSTRUCTED HOST INSTANCE, so the bootstrap leg
// can commit an external.apiKey custody change through the CAPTURED REAL
// bootstrap-built host.
const hostCfgCapture = vi.hoisted(() => ({ calls: [] as unknown[], instances: [] as unknown[] }));
// Rev 6 (R15-1) PRODUCTION-FAITHFUL ENGINE-INJECTION capture (header item 28,
// plan Part 4 v16 item 3): while `armed`, the SAME vi.mock's resolveNodeEngine
// leg constructs a REAL LlamaEngine from the INDEX-SUPPLIED options instead of
// letting the TRAININGAPP_DESKTOP_ENGINE='stub' short-circuit return
// StubEngine (the short-circuit ignores the externalProvider overrides incl.
// any custody sink and rejects both 'inference.profile' and 'external.apiKey'
// as unknown settings — executed UNGREENABLE by 06 :1234-1240). TEST-SIDE
// ONLY: production engine-selection semantics, StubEngine, and resolveNodeEngine
// are UNCHANGED — every other leg of this file delegates to the real export.
const engineCapture = vi.hoisted(() => ({ armed: false, stubShortCircuitsBypassed: 0, constructed: [] as unknown[], warmups: 0 }));
vi.mock('../../main/backend/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/index.js')>();
  const llamaEngineMod = await import('../../main/backend/inference/llama-engine.js');
  return {
    ...actual,
    resolveNodeEngine: (env: Record<string, string | undefined> = process.env, overrides?: Parameters<typeof actual.resolveNodeEngine>[1]) => {
      // R15-1 (plan Part 4 v16 item 3): mirror the NON-STUB construction at
      // llama-engine.ts:847-857 with the SAME index-supplied options — the
      // e1 env recipe keeps TRAININGAPP_DESKTOP_ENGINE='stub' (the stub host
      // stays lightweight for every OTHER bootstrap concern), but the
      // bootstrap leg's engine is the REAL LlamaEngine carrying whatever the
      // index supplied (userDataPath/models/externalProvider incl. any
      // startup-built custody sink/gpuVerdict/...).
      if (engineCapture.armed && env.TRAININGAPP_DESKTOP_ENGINE === 'stub') {
        engineCapture.stubShortCircuitsBypassed += 1;
        const threads = llamaEngineMod.parseEnvThreads(env.TRAININGAPP_DESKTOP_INFERENCE_THREADS);
        const profileEnv = env.TRAININGAPP_DESKTOP_INFERENCE_PROFILE;
        const profile = profileEnv === 'quality' || profileEnv === 'fast' || profileEnv === 'auto' ? profileEnv : undefined;
        const engine = new llamaEngineMod.LlamaEngine({
          modelDir: env.TRAININGAPP_INFERENCE_MODEL_DIR,
          userDataPath: overrides?.userDataPath,
          ...(overrides?.models !== undefined ? { models: overrides.models } : {}),
          ...(overrides?.externalProvider !== undefined ? { externalProvider: overrides.externalProvider } : {}),
          ...(overrides?.gpuVerdict !== undefined ? { gpuVerdict: overrides.gpuVerdict } : {}),
          ...(overrides?.onGpuLoadFailure !== undefined ? { onGpuLoadFailure: overrides.onGpuLoadFailure } : {}),
          ...(overrides?.gpuVerdictDir !== undefined ? { gpuVerdictDir: overrides.gpuVerdictDir } : {}),
          profile,
          ...(threads !== undefined ? { threads } : {}),
        });
        // The constructed instance's warmup is SPIED (header item 28): the
        // bootstrap's first-run callback fire-and-forgets
        // `void engine.warmup?.().catch(() => {})` (index.ts:1101-1105) — the
        // spy records the invocation and keeps the model-load side effect
        // ABSENT (a real warmup on a model-less engine only console.errors,
        // and the leg's warmup assertion must not depend on that noise).
        engine.warmup = async () => { engineCapture.warmups += 1; };
        engineCapture.constructed.push(engine);
        return engine;
      }
      return actual.resolveNodeEngine(env, overrides);
    },
    createBackendHost: (...args: Parameters<typeof actual.createBackendHost>) => {
      hostCfgCapture.calls.push(args[0]);
      const host = actual.createBackendHost(...args);
      hostCfgCapture.instances.push(host);
      return host;
    },
  };
});

// Construction capture for the rev-5 BOOTSTRAP PACK leg (R14-2; the
// production file's wave-12 instance-recorder pattern): a faithful subclass
// around the REAL PackManager export (identical behavior elsewhere; while
// armed it records the options AND the CONSTRUCTED INSTANCE after super()),
// so the bootstrap leg can drive a REAL install/remove through the manager
// the BOOTSTRAP-BUILT host wired — the actual index composition, never a
// test-constructed manager.
const pmCapture = vi.hoisted(() => ({ armed: false, options: [] as unknown[], instances: [] as unknown[] }));
vi.mock('../../main/backend/store/pack-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/store/pack-manager.js')>();
  const RealPackManager = actual.PackManager;
  return { ...actual, PackManager: class extends RealPackManager {
    constructor(opts: ConstructorParameters<typeof RealPackManager>[0]) {
      if (pmCapture.armed) pmCapture.options.push(opts);
      super(opts);
      if (pmCapture.armed) pmCapture.instances.push(this); // after super(): `this` is legal here
    }
  } };
});

// bootstrap itself EXISTS at base (the e1-packaged-glue-hardening precedent
// imports it the same way), so this static top-level import is safe pre-fix;
// the rev-4 bootstrap leg below drives it under the electron stub.
import { bootstrap } from '../../main/index.js';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repo root not found (marker contracts/api.openapi.yaml)');
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const itReal = nativeDepsIt('audit-outbox-custody-routes'); const TOKEN = 'audit-outbox-custody-routes-token';
const tempDirs: string[] = []; const openStores: Array<{ close(): void }> = []; const openServers: http.Server[] = []; const startedHosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (startedHosts.length > 0) await startedHosts.pop()!.stop().catch(() => undefined);
  for (const s of openServers.splice(0)) try { s.close(); } catch { /* closed */ }
  for (const s of openStores.splice(0)) try { s.close(); } catch { /* closed */ }
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir;
}

/** The declared delivery-seam payload (frozen C4's harness contract). */
interface DesktopAuditEnvelope { eventId: string; event: 'pack_install' | 'pack_remove' | 'settings_change'; subject: string; occurredAt: number }
/** The R9-3 request-scoped batch view (production file header item 2). */
interface CustodyBatch { capture(envelope: DesktopAuditEnvelope): void; flush(): void | Promise<void>; discard(): void }
/** A beginRequest()-shaped custody provider. */
interface CustodyProvider { beginRequest(): CustodyBatch }

/** Declared NEW-SURFACE contract of desktop/main/backend/audit-outbox.ts (the companion production spec harness-contract item 2, and header item 22 of this file). */
interface RoutesOutboxModule {
  createProductionCustodySink(getStore: () => { db: unknown } | null, notify?: (payload: { generation: number; pendingCount: number }) => void): CustodyProvider;
  bindOutboxBinding(store: { db: unknown }, prefix: string, sender?: number): Promise<{ prefix: string; generation: number }>;
  /** Header item 22: the R10-4 LEGACY-SINK ADAPTER — accepts EITHER a beginRequest() provider OR a plain { capture, flush, discard } object wrapped as one-shot forwarding batches. */
  adaptLegacyCustodySink(sink: CustodyProvider | { capture(envelope: DesktopAuditEnvelope): void; flush(): void | Promise<void>; discard(): void }): CustodyProvider;
}

/** The real first-run handler's result arm (index.ts:1049-1053, :1107-1111). */
type FirstRunCompleteResult = { ok: true } | { ok: false; detail: string; reason?: string };
/** Declared NEW-SURFACE contract of desktop/main/first-run/complete-handler.ts (rev-2 header item 25 + rev-3 item 25b): the EXTRACTED 'desktop:first-run:complete' body AND the extracted REGISTRATION index.ts performs. */
interface FirstRunHandlerModule {
  buildFirstRunCompleteHandler(deps: {
    completeWizard(payload: { selectedProfile: 'quality' | 'fast'; acknowledgedLicenses: boolean }): Promise<void> | void;
    backendHost: { applyEngineSettings?: (patch: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; status: number; detail: string }> | { ok: true } | { ok: false; status: number; detail: string } } | null | undefined;
    engine: { warmup?: () => void | Promise<void> };
  }): (payload: unknown) => Promise<FirstRunCompleteResult>;
  /** Rev-3 header item 25b (R12-2) + the rev-4 adapter (R13-3): calls buildFirstRunCompleteHandler(deps) and registers the RESULTING handler via ipc.handle('desktop:first-run:complete', handler) — never the factory uncalled — where `handler` is registered with the REAL Electron (event, payload) dispatch (an explicit adapter `(_event, payload) => product(payload)`, or the handler itself declared two-argument). */
  registerFirstRunCompleteIpc(ipc: { handle(channel: string, callback: unknown): void }, deps: Parameters<FirstRunHandlerModule['buildFirstRunCompleteHandler']>[0]): void;
}

/** One row of the real audit_outbox table (plan Part 4 item 1 columns). */
interface OutboxRow { event_id: string; seq: number; event: string; subject: string; occurred_at: number }

const requireNative = createRequire(import.meta.url);

/** Read audit_outbox on a BRAND-NEW SEPARATE connection (WAL: only COMMITTED rows visible). */
function readOutboxOnFreshConnection(dbPath: string): { rows: OutboxRow[]; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { all(): unknown[] }; close(): void };
    const conn = new Database(dbPath);
    try { return { rows: conn.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox').all() as OutboxRow[], error: null }; } finally { conn.close(); }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Rev-5 bootstrap pack leg (R14-2): BOTH the audit_outbox envelopes AND the packs-REGISTRY rows read on ONE fresh connection of the bootstrap host's OWN store — the non-vacuity companion for every exactly-one-envelope assertion (the commit really happened). */
function readPackEvidenceOnFreshConnection(dbPath: string): { envelopes: OutboxRow[]; registryRows: Array<{ id: string; version: string }>; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { all(): unknown[] }; close(): void };
    const conn = new Database(dbPath);
    try {
      const envelopes = conn.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox').all() as OutboxRow[];
      const registryRows = conn.prepare('SELECT id, version FROM packs').all() as Array<{ id: string; version: string }>;
      return { envelopes, registryRows, error: null };
    } finally { conn.close(); }
  } catch (err) {
    return { envelopes: [], registryRows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Copy a fixture pack, retargeting its embedding block to the test HashEmbedder (the production file's c7 rewrite — the bootstrap pack leg needs the same staging). */
function stageFixture(root: string, name: string): string {
  const dest = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  const manifestPath = path.join(dest, 'pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.embedding = { model_id: 'hash-test', dims: 8, normalize: false };
  for (const entry of manifest.docs as Array<{ path: string; sha256: string }>) entry.sha256 = createHash('sha256').update(fs.readFileSync(path.join(dest, entry.path))).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dest;
}

/** A deterministic one-shot gate — the controllable barrier (no sleeps, no polling). */
function makeGate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Rev-4 bootstrap leg (R13-1/R13-3): bounded 25ms poll — the e1-packaged-glue-hardening waitFor recipe — that RESOLVES A BOOLEAN instead of throwing on a missed deadline, so the caller turns a timeout into a NAMED assertion failure (never an anonymous hanging error; plan Part 4 v14 item 3). */
async function boundedPoll(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Thin delegating provider: forwards every batch call to the REAL provider while recording the event ORDER (begin/capture/flush/discard). awaitCapture(n) is the R11-5 PER-REQUEST/PER-COUNT barrier (header item 29): it resolves ONLY once at least n captures have been RECORDED — never on the mere existence of an earlier capture (the wave-10 helper bug: after A captured, the second wait resolved immediately with captures=1, 06 :1017-1018). */
function makeObservedProvider(real: CustodyProvider): { provider: CustodyProvider; events: string[]; awaitCapture: (n: number) => Promise<void> } {
  const events: string[] = [];
  let captureCount = 0;
  const waiters: Array<{ needed: number; resolve: () => void }> = [];
  const settle = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (captureCount >= waiters[i]!.needed) { waiters[i]!.resolve(); waiters.splice(i, 1); }
    }
  };
  const provider: CustodyProvider = {
    beginRequest(): CustodyBatch {
      events.push('begin');
      const batch = real.beginRequest();
      return {
        capture: (envelope: DesktopAuditEnvelope) => { events.push(`capture:${envelope.eventId}`); captureCount += 1; batch.capture(envelope); settle(); },
        flush: () => { events.push('flush'); return batch.flush(); },
        discard: () => { events.push('discard'); batch.discard(); },
      };
    },
  };
  const awaitCapture = (n: number): Promise<void> => new Promise<void>((resolve) => {
    if (captureCount >= n) resolve();
    else waiters.push({ needed: n, resolve });
  });
  return { provider, events, awaitCapture };
}

/** A real SQLite workspace store opened the way the pack lifecycle does. */
async function openWorkspaceStore(prefix: string): Promise<{ root: string; dbPath: string; store: { db: unknown; close(): void } }> {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const root = makeTempDir(prefix);
  const dbPath = path.join(root, 'store.db');
  const store = storeMod.openStore({ dbPath, dims: 8 });
  openStores.push(store); return { root, dbPath, store };
}

/** The REAL node-mode server over the REAL engine — /settings only; persistExternal is the DECLARED deferred-persist seam (void | Promise<void>, awaited by the commit) and RECEIVES the external snapshot the route computed (server.ts:1011-1013). Rev 3 (R12-4): the optional onSettingsSectionEntry test seam (rev-3 header item 26) threads into the server options when given. */
async function startSettingsServer(engine: unknown, persistExternal: (snapshot: Record<string, unknown>) => void | Promise<void>, onSettingsSectionEntry?: (section: { patch: Record<string, unknown> }) => void): Promise<{ port: number }> {
  const serverMod = await import('../../main/backend/server.js');
  const guardMod = await import('../../main/security/loopback-guard.js');
  const server = serverMod.createBackendServer({ guard: guardMod.createLoopbackGuard({ token: TOKEN }), tokenHeaderName: 'X-Desktop-Token', engine: engine as never, persistExternal: persistExternal as (snapshot: Record<string, unknown>) => void, ...(onSettingsSectionEntry !== undefined ? { onSettingsSectionEntry } : {}) } as never);
  const port = await serverMod.listenOnRandomPort(server);
  openServers.push(server); return { port };
}

async function putSettings(port: number, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings`, { method: 'PUT', headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(patch) });
}

/** Final LIVE settings cross-check (GET /settings = engine.responseSettings(), server.ts:932-933). */
async function getSettings(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/settings`, { headers: { 'x-desktop-token': TOKEN } });
  return (await res.json()) as Record<string, unknown>;
}

/** In-memory SecretStore double (the wave-5 makeFakeSecretStore shape). */
function makeFakeSecretStore() {
  const map = new Map<string, string>();
  const deleteHistory: string[] = [];
  return { map, deleteHistory, persistent: true, get: (name: string) => map.get(name) ?? null, set: (name: string, value: string) => { map.set(name, value); }, delete: (name: string) => { deleteHistory.push(name); map.delete(name); } };
}

/** A REAL NodeBackendHost over the given engine (config.engine short-circuits resolveNodeEngine — the importable applyEngineSettings seam backend/index.ts:932-948 exposes). Rev 3 (R12-4): the optional onSettingsSectionEntry test seam (rev-3 header item 26) threads into the host config when given — applyEngineSettings sections fire the SAME seam. */
async function startCustodyHost(engine: unknown, onSettingsSectionEntry?: (section: { patch: Record<string, unknown> }) => void): Promise<{ applyEngineSettings?: (patch: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; status: number; detail: string }> | { ok: true } | { ok: false; status: number; detail: string }; stop(): Promise<void> }> {
  const hostMod = await import('../../main/backend/index.js');
  const root = makeTempDir('audit-custody-routes-host-');
  const host = hostMod.createBackendHost({
    mode: 'node', token: TOKEN, tokenHeaderName: 'X-Desktop-Token',
    engine: engine as never,
    storePath: path.join(root, 'profiles', 'test', 'store.sqlite'),
    storeEmbeddingDims: 8,
    env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
    ...(onSettingsSectionEntry !== undefined ? { onSettingsSectionEntry } : {}),
  } as never);
  startedHosts.push(host);
  await host.start();
  return host as never;
}

/** Forced post-capture OUTER failure: the host's persistExternal closure calls engine.externalSnapshot (backend/index.ts:939-941) — making it THROW turns the persist step into the rollback class AFTER custody captured. */
class SnapshotThrowingEngine extends LlamaEngine {
  override externalSnapshot(): Record<string, unknown> {
    throw new Error('external snapshot failed (routes probe)');
  }
}

// ---- REV 17 SOURCE-LEVEL PIN (plan Part 4 v27): two static claims, and only
// these — (1) the module-bound import finder (R13-2 — the binding module
// specifier must RESOLVE to the exact expected file; name-only matching is
// forbidden); (2) the SOURCE CENSUS — the target name is USED exactly once in
// the repository production source, as a direct call in index.ts. Whether the
// registration is live and single is proven executably by the BOOTSTRAP leg
// above (exactly one live registration from the REAL bootstrap). The rev 3-11
// static supplement machinery, the rev 12-13 counting spies, and the rev 13
// mechanism gate are RETIRED WITH their machinery (plan Part 4 v27; 06 Rounds
// 12-22).
/** The checker program over the REAL index.ts (noLib/skipLibCheck/noEmit — diagnostics never read; only symbol resolution matters). */
function buildIndexProgram(indexPath: string): ts.Program {
  return ts.createProgram([indexPath], {
    noEmit: true, noLib: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
  });
}

/** R13-2 MODULE-BOUND resolution (rev 4; plan Part 4 v14 item 3): the canonical absolute path a RELATIVE module specifier (imported by `fromFile`) resolves to under the program's NodeNext mapping (`./x.js` → `x.ts` beside it, directory-index forms included), or null when it resolves to no existing file. Non-relative specifiers cannot resolve to the in-repo expected module under this program's options — null (fail closed). */
function resolveSpecifierPath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const stem = specifier.replace(/\.(js|mjs|cjs)$/i, '');
  const candidates = [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${stem}/index.ts`, `${stem}/index.js`, stem];
  for (const candidate of candidates) {
    const abs = path.resolve(path.dirname(fromFile), candidate);
    try {
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return abs;
    } catch { /* unreadable — treat as unresolvable */ }
  }
  return null;
}

/** The MODULE-BOUND import symbol for `name` (rev 4, R13-2 — the name-only findImportedSymbol is DELETED): the checker symbol of the NamedImports binding, ONLY when the ImportDeclaration's module specifier RESOLVES to `expectedFile` (canonical path compare). A same-named binding from ANY other module returns undefined (wrong-module FAIL) and a binding whose expected module cannot be resolved returns undefined (fail-closed: name-only matching is forbidden, 06 :1136-1142). */
function findModuleBoundImportedSymbol(sf: ts.SourceFile, checker: ts.TypeChecker, name: string, expectedFile: string): ts.Symbol | undefined {
  let bound: ts.Symbol | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause === undefined || st.importClause.namedBindings === undefined || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    for (const el of st.importClause.namedBindings.elements) {
      if (el.name.text !== name) continue;
      if (!ts.isStringLiteral(st.moduleSpecifier)) return undefined; // a non-literal specifier cannot be bound to the exact expected module
      const resolved = resolveSpecifierPath(sf.fileName, st.moduleSpecifier.text);
      if (resolved === null || path.resolve(resolved) !== path.resolve(expectedFile)) return undefined; // wrong module, or the expected module cannot be resolved — both FAIL CLOSED
      bound = checker.getSymbolAtLocation(el.name) ?? checker.getSymbolAtLocation(el) ?? bound;
    }
  }
  return bound;
}

/** REV 17 SOURCE CENSUS (plan Part 4 v27): every USAGE of `name` in the repository production source text — an identifier whose text equals `name` that is NOT in an import/export binding position, or a string literal equal to `name`. Scanned: every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs file under the repository root, skipping node_modules, .git, .agents, dist, out, build, coverage, __tests__, tests, test, and e2e, and skipping the defining module (its declaration and its export). A name assembled at runtime is not source text and is outside the census by definition — the pin states the scope of the exactly-once claim. A usage under another name (an aliased import of the target, or an alias export of the defining module called elsewhere) is outside the census, as is a name assembled at runtime. The pin is SYNTACTIC: a dead direct call is still one literal usage and passes it; REACHABILITY is not claimed. Whether the registration is live and single is proven executably by the BOOTSTRAP leg above (exactly one live registration from the REAL bootstrap) — never by this function. */
function collectNameUsages(name: string, definingFile: string): Array<{ file: string; isDirectCall: boolean }> {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', 'dist', 'out', 'build', 'coverage', '__tests__', 'tests', 'test', 'e2e']);
  const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const usages: Array<{ file: string; isDirectCall: boolean }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!SOURCE_EXT.test(entry.name) || path.resolve(full) === path.resolve(definingFile)) continue;
      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const isIdentifier = ts.isIdentifier(node) && node.text === name;
        const isLiteral = (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === name;
        if (isIdentifier || isLiteral) {
          const p = node.parent;
          const bindingPosition = isIdentifier && p !== undefined && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p));
          if (!bindingPosition) usages.push({ file: full, isDirectCall: p !== undefined && ts.isCallExpression(p) && p.expression === node });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(REPO_ROOT);
  return usages;
}

describe('audit-outbox-custody-routes (rev 17 — plan Part 4 v27): request-threaded custody under the settings-commit MUTEX with REQUEST-ARRIVAL barriers (onSettingsSectionEntry) — real concurrent PUT /settings routes in BOTH orders with FINAL-state assertions (responseSettings/SecretStore/external snapshot/own audit row) / per-request capture barriers / applyEngineSettings ordering through the same mutex / first-run AWAIT ordering through the REAL IPC handler (inference-only patch re-scoped to await/registration proofs — no custody-row assertion for that patch, R14-1) + REGISTRATION executed (registerFirstRunCompleteIpc, recording fake ipcMain, captured(null, payload) — the REAL Electron signature) + the shipped-caller BOOTSTRAP execution FIRST IN THE DESCRIBE carrying the PRODUCTION-FAITHFUL ENGINE INJECTION of header item 28 and the HERMETIC fast→quality TRANSITION of header item 29 ride the same leg — R13-3 + R14-1 + R14-2 + R15-1 + R16-2; REAL pack install/remove through the CAPTURED bootstrap-built manager, one durable envelope per commit, and the external.apiKey custody commit ok:true + one durable row through the CAPTURED bootstrap-built host) / the source-level pin (module-bound import existence + the source census, plan Part 4 v27)) / legacy-sink adapter with TWO sequential PUTs (#373 AC1 — R10-4, R11-3, R11-5, R12-2, R12-4, R13-2, R13-3, R14-1, R14-2, R15-1, R16-2)', () => {
  it('shipped-caller BOOTSTRAP execution (rev 17 — plan Part 4 v27; FIRST in the describe; rev 7, R13-1 + R13-3 + R14-1 + R14-2 + R15-1 + R16-2 — the FUNDAMENTAL shipped-caller proof, plan Part 4 v17 item 3; the separately tested correct builder/registration functions do not prove that index reaches them): import bootstrap from the REAL desktop/main/index.ts and execute the actual registered app.whenReady callback under the desktop electron stub with injected env (the e1-packaged-glue-hardening recipe) and the PRODUCTION-FAITHFUL ENGINE INJECTION of header item 28 — the leg\'s vi.mock of backend/index.js intercepts resolveNodeEngine so the TRAININGAPP_DESKTOP_ENGINE=\'stub\' short-circuit (which returns StubEngine, ignores the externalProvider overrides incl. the custody sink, and rejects both \'inference.profile\' and \'external.apiKey\' as unknown settings — the executed UNGREENABLE shape of 06 :1234-1240, zero captures) is bypassed and a REAL LlamaEngine is constructed from the SAME index-supplied options (mirroring llama-engine.ts:847-857; TEST-SIDE ONLY — production engine-selection semantics, StubEngine, and resolveNodeEngine UNCHANGED; the instance\'s warmup is SPIED so no model-load side effect occurs), then (i) capture the ACTUAL registered desktop:first-run:complete callback from the stub ipcMain.handle recorder — exactly ONE registration, the callback is NOT the factory — and invoke it as captured(null, payload), the REAL Electron (event, payload) dispatch, asserting result.ok === true AND that the engine ACTUALLY ACCEPTED the inference patch (the constructed instance\'s captureSettingsState() shows inference.profile === selectedProfile — genuine acceptance through the INDEX-SUPPLIED dependencies, never the nonfatal-masking path that made the rev-5 ok:true non-evidentiary — proven as a HERMETIC BEFORE/AFTER TRANSITION per header item 29, R16-2: the env roster saves/clears/restores TRAININGAPP_DESKTOP_INFERENCE_PROFILE with the other keys and arranges the NON-quality startup profile \'fast\', the constructed engine is asserted NOT already \'quality\' BEFORE the callback, and the exact TRANSITION fast → quality is required AFTER it plus warmup — a dropped/ignored inference patch that still returns ok:true cannot satisfy the transition) AND that warmup was invoked (spy; never test-supplied valid deps; the inference-only first-run patch emits NO custody envelope by design — R14-1 — so the index-supplied custody chain is proven separately in (iv) with an EXTERNAL key); and (ii) assert the startup reachability observable — the createBackendHost config captured during the bootstrap execution carries the startup-built auditSink (at base the R5-6 seam does not exist: RED right-reason at the NAMED assertion, never an import error or unhandled rejection — bootstrap itself exists at base and its whenReady chain carries a .catch; presence of an emit function alone is NOT evidence — R14-2) — plus (ii-b) the R15-1 injection is load-bearing: EXACTLY ONE engine was constructed, it IS a LlamaEngine and NOT StubEngine, and the stub short-circuit it bypassed is recorded; and (iii) execute a REAL pack install and a REAL pack remove through the CAPTURED bootstrap-built PackManager, asserting EXACTLY ONE durable envelope per commit (pack_install, then pack_remove) with the packs-registry row on the SAME ONE fresh connection of the bootstrap host\'s OWN store (manager and sink aligned BY CONSTRUCTION — both are the host store; the index-level no-op-override shape `{ ...startup.hostConfig, auditSink: { emit() {} } }` produces ZERO envelopes and is a REQUIRED RED mutant — 06 :1193-1199); and (iv) commit an external.apiKey custody change through the CAPTURED bootstrap-built host — ok:true (REAL acceptance through the injected LlamaEngine carrying the index-supplied externalProvider, not a StubEngine 422) AND exactly one durable settings_change row through the index-supplied sink on a fresh connection (the R14-1 + R15-1 index-supplied custody-chain proof) (audit-outbox-custody-routes)', async () => {
    // The e1 env recipe: save/clear the desktop env seams, inject a temp
    // store + packs dir and the stub engine; restore in finally. Dev mode
    // (no staged manifest) keeps the wizard gates satisfiable: manifestOk
    // resolves null (not applicable) and no manifest means no required
    // packs, so a valid completion payload reaches the engine seam. Rev 5
    // (R14-2): the hash embedder + packs embedding-model pin join the env
    // so the bootstrap-built host constructs its PackManager and accepts
    // the hash-test fixture (the production pack leg's env combo). Rev 6
    // (R15-1, header item 28): the stub ENGINE env STAYS — but the armed
    // ENGINE INJECTION turns that short-circuit into a REAL LlamaEngine
    // built from the index-supplied options, so the stub host stays
    // lightweight while the custody/acceptance proofs run against the real
    // engine selection the non-stub path performs (llama-engine.ts:847-857).
    // Rev 7 (R16-2, header item 29 — plan Part 4 v17 item 3): the roster
    // ALSO saves/clears/restores TRAININGAPP_DESKTOP_INFERENCE_PROFILE and
    // EXPLICITLY arranges the NON-quality startup profile 'fast' — the
    // hermetic BEFORE state the acceptance TRANSITION proof needs (an
    // inherited 'quality' value could pre-satisfy the post-callback
    // assertion; 06 :1296-1302 executed exactly that FALSE-GREEN; the
    // ordinary default is 'auto', llama-engine.ts:969-974).
    const ENV_KEYS = ['TRAININGAPP_DESKTOP_MANIFEST', 'TRAININGAPP_DESKTOP_STORE_PATH', 'TRAININGAPP_DESKTOP_PACKS_DIR', 'TRAININGAPP_DESKTOP_ENGINE', 'TRAININGAPP_DESKTOP_EMBEDDER', 'TRAININGAPP_PACKS_EMBEDDING_MODEL_ID', 'TRAININGAPP_EMBEDDING_MODEL_DIR', 'TRAININGAPP_RERANKER_MODEL_DIR', 'TRAININGAPP_DESKTOP_INFERENCE_PROFILE'] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
    const iso = makeTempDir('audit-bootstrap-shipped-');
    const storePath = path.join(iso, 'profiles', 'default', 'store.sqlite');
    process.env.TRAININGAPP_DESKTOP_STORE_PATH = storePath;
    process.env.TRAININGAPP_DESKTOP_PACKS_DIR = path.join(iso, 'packs');
    process.env.TRAININGAPP_DESKTOP_ENGINE = 'stub';
    process.env.TRAININGAPP_DESKTOP_EMBEDDER = 'hash';
    process.env.TRAININGAPP_PACKS_EMBEDDING_MODEL_ID = 'hash-test';
    process.env.TRAININGAPP_DESKTOP_INFERENCE_PROFILE = 'fast'; // R16-2: the arranged NON-quality startup profile — the engine the bootstrap constructs must start 'fast' and TRANSITION to 'quality' only through the first-run patch
    expect(typeof resetElectronStub, 'the desktop electron stub exposes its reset (__resetElectronStub) through the vitest alias — the e1-packaged-glue-hardening reset pattern (plan Part 4 v16 item 3)').toBe('function');
    resetElectronStub!();
    hostCfgCapture.calls.length = 0; hostCfgCapture.instances.length = 0;
    pmCapture.options.length = 0; pmCapture.instances.length = 0; pmCapture.armed = true;
    // Rev 6 (R15-1, header item 28): arm the ENGINE INJECTION for this leg —
    // the e1 env below still sets TRAININGAPP_DESKTOP_ENGINE='stub' (the stub
    // host stays lightweight for every OTHER bootstrap concern), but the
    // mocked resolveNodeEngine constructs a REAL LlamaEngine from the
    // index-supplied options instead of returning StubEngine.
    engineCapture.constructed.length = 0; engineCapture.warmups = 0; engineCapture.stubShortCircuitsBypassed = 0; engineCapture.armed = true;
    try {
      expect(typeof bootstrap, 'the REAL desktop/main/index.ts exports bootstrap — the shipped entry this leg executes (present at base; the e1-packaged-glue-hardening precedent imports it identically; plan Part 4 v15 item 3)').toBe('function');
      bootstrap();
      const registered = await boundedPoll(() => (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'desktop:first-run:complete'), 8000);
      expect(registered, 'the ACTUAL shipped whenReady callback registered the desktop:first-run:complete handler — when this is the only registration path, a dead (`if (false)`) registration or an imported-but-uncalled registerFirstRunCompleteIpc leaves ZERO registrations and is named RED; if an inline handler remains, the count is one and the extracted call is checked by the source-level pin instead (plan Part 4 v27 item 3, R13-1)').toBe(true);
      // (ii) the startup reachability observable: the createBackendHost
      // config captured during the actual bootstrap execution.
      expect(hostCfgCapture.calls.length, 'the bootstrap whenReady callback constructed the backend host through createBackendHost — the passthrough-recorded config IS the startup composition seam (the e1 resolveNodeEngine recorder pattern; plan Part 4 v15 item 3)').toBeGreaterThan(0);
      const hostCfg = hostCfgCapture.calls[0] as { auditSink?: unknown } | undefined;
      expect(typeof (hostCfg!.auditSink as { emit?: unknown } | null)?.emit, 'the createBackendHost config captured during the ACTUAL bootstrap execution carries the startup-built auditSink (emit view) — the R5-6 seam buildProductionStartup threads into the host config; at base the seam does not exist and this NAMED assertion is RED right-reason (plan Part 4 v16 item 3, R12-3/R13-1). Presence of an emit function alone is NOT evidence (R14-2) — the REAL pack commits through the bootstrap-built manager in (iii) are the behavioral proof behind this assertion.').toBe('function');
      // (ii-b) R15-1 — the PRODUCTION-FAITHFUL ENGINE INJECTION is
      // load-bearing and really ran: the bootstrap executed under
      // TRAININGAPP_DESKTOP_ENGINE='stub' (the e1 recipe), whose REAL
      // resolveNodeEngine would short-circuit to `new StubEngine()`
      // (llama-engine.ts:820-840) — ignoring the externalProvider overrides
      // (incl. the custody sink) and rejecting both 'inference.profile' and
      // 'external.apiKey' as unknown settings; the executed UNGREENABLE shape
      // of 06 :1234-1240 is {engine:"StubEngine", both patches 422,
      // captures:0}. The leg's test-side interception (header item 28)
      // constructed a REAL LlamaEngine from the SAME index-supplied options
      // instead — mirroring the non-stub construction at
      // llama-engine.ts:847-857.
      const engineMod = await import('../../main/backend/engine.js');
      expect(engineCapture.stubShortCircuitsBypassed, 'the ENGINE INJECTION really engaged: the armed resolver saw the \'stub\' short-circuit path at least once and bypassed it — without the injection the leg runs on StubEngine and the acceptance/custody assertions below are UNGREENABLE (06 :1234-1240; plan Part 4 v16 item 3, R15-1)').toBeGreaterThanOrEqual(1);
      expect(engineCapture.constructed.length, 'EXACTLY ONE engine was constructed by the injected resolver — the shipped index resolves its engine exactly once (index.ts:424; plan Part 4 v16 item 3, R15-1)').toBe(1);
      const bootstrapEngine = engineCapture.constructed[0] as InstanceType<typeof LlamaEngine>;
      expect(bootstrapEngine instanceof LlamaEngine, 'the bootstrap leg ran on a REAL LlamaEngine constructed from the INDEX-SUPPLIED options — the injection mirrors llama-engine.ts:847-857 with whatever the real index passed (userDataPath/models/externalProvider incl. any startup-built custody sink; plan Part 4 v16 item 3, R15-1)').toBe(true);
      expect(bootstrapEngine instanceof engineMod.StubEngine, 'the constructed engine is NOT StubEngine — the R15-1 differential: under the un-injected stub wiring the REAL resolver returns new StubEngine(), which ignores the externalProvider overrides and rejects both frozen patches as unknown settings (executed 422/422, zero captures; 06 :1234-1240; plan Part 4 v16 item 3, R15-1)').toBe(false);
      // (i) the ACTUAL registered first-run callback, invoked with the
      // REAL Electron (event, payload) signature.
      const registrations = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'desktop:first-run:complete');
      expect(registrations.length, 'EXACTLY ONE live registration for desktop:first-run:complete from the ACTUAL shipped whenReady callback (a duplicate in-source registration fails here; plan Part 4 v15 item 3)').toBe(1);
      const captured = registrations[0]![1] as (event: unknown, payload: unknown) => Promise<FirstRunCompleteResult>;
      expect(typeof captured, 'the shipped registered callback is a FUNCTION').toBe('function');
      const handlerMod = (await import('../../main/first-run/complete-handler.js').catch(() => null)) as FirstRunHandlerModule | null;
      if (handlerMod !== null && typeof handlerMod.buildFirstRunCompleteHandler === 'function') {
        expect(captured, 'the shipped registered callback is NOT the factory itself (the uncalled-factory shape; the complete-handler module is absent at base so this identity check is guarded, and the leg is already RED at the named auditSink assertion above; plan Part 4 v15 item 3)').not.toBe(handlerMod.buildFirstRunCompleteHandler);
      }
      // (a-pre, R16-2) HERMETIC BEFORE STATE (plan Part 4 v17 item 3; header
      // item 29): the env roster cleared TRAININGAPP_DESKTOP_INFERENCE_PROFILE
      // and explicitly arranged 'fast', so the engine the bootstrap
      // constructed (through the mocked resolver, which derives its profile
      // from that env exactly as resolveNodeEngine does,
      // llama-engine.ts:842-845) is NOT already 'quality' BEFORE the
      // callback runs — the pre-state the rev-6 assertion lacked (06
      // :1296-1302 executed the stale-`quality` FALSE-GREEN: with no BEFORE
      // state, an inherited TRAININGAPP_DESKTOP_INFERENCE_PROFILE=quality
      // pre-satisfied the sole post-callback predicate and a dropped patch
      // still passed). Asserting the exact arranged profile 'fast' (not
      // merely !== 'quality') also proves the cleared env really threaded
      // through the construction.
      const preState = (bootstrapEngine as unknown as { captureSettingsState(): { profileSetting: string } }).captureSettingsState();
      expect(preState.profileSetting, 'BEFORE the captured first-run callback is invoked the constructed REAL LlamaEngine is NOT already quality — captureSettingsState().profileSetting === the arranged hermetic startup profile (fast; an inherited TRAININGAPP_DESKTOP_INFERENCE_PROFILE=quality value is cleared by the env roster, so no stale startup state can pre-satisfy the acceptance TRANSITION asserted below; the ordinary default would be auto, llama-engine.ts:969-974; plan Part 4 v17 item 3, R16-2)').toBe('fast');
      const result = await captured(null, { selectedProfile: 'quality', acknowledgedLicenses: true });
      expect(result.ok, 'the shipped registered callback, invoked as captured(null, payload) — the REAL Electron (event, payload) dispatch, the e1-packaged-glue-hardening invocation shape — completed ok for a valid payload through the INDEX-SUPPLIED dependencies (a one-argument product registered directly receives the event object as payload and every real request is refused profile-not-selected, failing exactly this assertion; plan Part 4 v16 item 3, R13-3). NO custody-row assertion follows this invocation: the first-run patch is inference-only and emits NO envelope by design (R14-1) — the index-supplied custody chain is proven in (iv) with an EXTERNAL key.').toBe(true);
      // (a-strengthened, R15-1 + R16-2) GENUINE acceptance as an exact
      // TRANSITION, not the nonfatal-masking path and not stale startup
      // state: the engine the index resolved (the injected REAL LlamaEngine
      // carrying the index-supplied options) started at the arranged hermetic
      // 'fast' (the (a-pre) assertion above) and must now show EXACTLY
      // 'quality' (captureSettingsState, llama-engine.ts:2091-2101) — a
      // dropped/ignored inference patch that still returns a successful
      // apply result CANNOT satisfy this (the profile would still be 'fast');
      // under the un-injected StubEngine wiring the patch was REJECTED 422
      // (unknown setting) while the handler still returned ok:true (engine
      // refusal is deliberately nonfatal, index.ts:1091-1092/:1107) — the
      // rev-5 ok:true was non-evidentiary (06 :1237), and the rev-6
      // post-only check was pre-satisfiable by an inherited 'quality'
      // (06 :1296-1302). At base the #133 applyEngineSettings seam is absent
      // (profileApplied stays undefined) and this NAMED transition assertion
      // is RED right-reason — never an import error (the leg is already RED
      // at the auditSink assertion above at base).
      const postState = (bootstrapEngine as unknown as { captureSettingsState(): { profileSetting: string } }).captureSettingsState();
      expect(postState.profileSetting, `the REAL LlamaEngine the index resolved ACTUALLY ACCEPTED the inference patch — the exact TRANSITION from the arranged hermetic startup profile '${preState.profileSetting}' to 'quality' (captureSettingsState().profileSetting === 'quality' AFTER the callback; genuine acceptance through the index-supplied dependencies, NOT the nonfatal-masking path where the engine refuses and the handler still returns ok:true, and NOT stale startup state — a defect that drops/ignores inference.profile while returning ok:true leaves the profile at '${preState.profileSetting}' and fails exactly this assertion; under the un-injected StubEngine wiring this patch is REJECTED as an unknown setting — 06 :1237 and 06 :1296-1302; plan Part 4 v17 item 3, R15-1 + R16-2)`).toBe('quality');
      expect(engineCapture.warmups, 'the shipped first-run callback INVOKED the engine\'s warmup on the success branch — the SPIED warmup of the injected REAL LlamaEngine recorded at least one invocation (production fire-and-forgets `void engine.warmup?.().catch(() => {})`, index.ts:1101-1105; the spy keeps the model-load side effect ABSENT; plan Part 4 v16 item 3, R15-1)').toBeGreaterThanOrEqual(1);
      // (iii) R14-2 — REAL pack commits through the BOOTSTRAP-BUILT host's
      // CAPTURED PackManager: manager and sink are the host's OWN store BY
      // CONSTRUCTION. An index that overrides the startup sink with a no-op
      // `{ emit() {} }` (while still calling buildProductionStartup) leaves
      // ZERO envelopes and fails the exactly-one assertions below —
      // presence of an emit function was never the proof.
      expect(pmCapture.instances.length, 'the BOOTSTRAP-BUILT host constructed its PackManager (the instance recorder captured the manager the ACTUAL index composition wired — plan Part 4 v15 item 3, R14-2)').toBeGreaterThan(0);
      const bootstrapManager = pmCapture.instances[0] as unknown as { install(packPath: string): Promise<unknown>; remove(packId: string, version?: string): Promise<unknown> };
      const bootstrapPackStaging = makeTempDir('audit-bootstrap-pack-stage-');
      await bootstrapManager.install(stageFixture(bootstrapPackStaging, 'bundled-min'));
      const afterBootstrapInstall = readPackEvidenceOnFreshConnection(storePath);
      expect(afterBootstrapInstall.error, "the bootstrap host's own store reads cleanly (envelopes + registry) on a fresh connection after the REAL install").toBeNull();
      expect(afterBootstrapInstall.envelopes.filter((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min')).length, 'a REAL pack install through the BOOTSTRAP-BUILT PackManager landed EXACTLY ONE durable pack_install envelope on the bootstrap host\'s OWN store — the shipped index composition really wires the startup pack sink (the index-level no-op-override shape `{ ...startup.hostConfig, auditSink: { emit() {} } }` leaves ZERO envelopes and FAILS exactly this assertion — presence of an emit function is not evidence; R14-2; plan Part 4 v15 item 3)').toBe(1);
      expect(afterBootstrapInstall.registryRows.filter((r) => r.id === 'bundled-min').length, 'the packs-registry row for the SAME commit is on the SAME ONE fresh connection — the exactly-one-envelope assertion is NON-VACUOUS (the install really committed; R14-2; plan Part 4 v15 item 3)').toBe(1);
      await bootstrapManager.remove('bundled-min');
      const afterBootstrapRemove = readPackEvidenceOnFreshConnection(storePath);
      expect(afterBootstrapRemove.envelopes.filter((r) => r.event === 'pack_remove' && String(r.subject).includes('bundled-min')).length, 'the REAL pack remove through the BOOTSTRAP-BUILT manager committed EXACTLY ONE durable pack_remove envelope — one envelope PER COMMIT on the actual index composition (R14-2; plan Part 4 v15 item 3)').toBe(1);
      expect(afterBootstrapRemove.registryRows.filter((r) => r.id === 'bundled-min').length, 'the remove\'s registry mutation is on the SAME connection — the row is GONE after the REAL remove (non-vacuous; R14-2; plan Part 4 v15 item 3)').toBe(0);
      // (iv) R14-1 — the INDEX-SUPPLIED custody chain: an external.apiKey
      // commit through the CAPTURED bootstrap-built host. The first-run
      // patch itself is inference-only (no envelope by design); THIS is the
      // durable-row proof that the shipped index really wires custody.
      const bootstrapHost = hostCfgCapture.instances[0] as { applyEngineSettings?: (patch: Record<string, unknown>) => Promise<{ ok: boolean }> | { ok: boolean } } | undefined;
      expect(typeof bootstrapHost!.applyEngineSettings, 'the CAPTURED bootstrap-built host exposes the applyEngineSettings seam (backend/index.ts:932-948; plan Part 4 v16 item 3, R14-1 + R15-1)').toBe('function');
      const custodyApply = await bootstrapHost!.applyEngineSettings!({ 'external.apiKey': 'sk-bootstrap-custody' });
      expect(custodyApply.ok, 'the external.apiKey commit through the CAPTURED bootstrap-built host committed ok — REAL acceptance through the injected LlamaEngine carrying the index-supplied externalProvider (under the un-injected StubEngine wiring this patch is REJECTED 422 as an unknown setting and ok:true is ungreenable — 06 :1234-1240; the R14-1 + R15-1 index-supplied custody-chain proof; plan Part 4 v16 item 3)').toBe(true);
      const afterCustody = readPackEvidenceOnFreshConnection(storePath);
      expect(afterCustody.envelopes.filter((r) => r.event === 'settings_change' && String(r.subject).includes('external.apiKey')).length, 'EXACTLY ONE durable settings_change row for the external.apiKey commit through the CAPTURED bootstrap-built host — the INDEX-SUPPLIED custody chain is real end-to-end: the commit was ACCEPTED by the real engine and its envelope landed through the sink the index supplied inside externalProvider (the first-run inference-only patch emits no envelope BY DESIGN, so THIS external-key commit is the shipped-index custody proof; kills missing-custody-wiring in index; R14-1 + R15-1; plan Part 4 v16 item 3)').toBe(1);
      expect(afterCustody.envelopes.filter((r) => r.event === 'settings_change').length, 'exactly the ONE custody row — no duplicate envelope for the commit (plan Part 4 v16 item 3, R14-1 + R15-1)').toBe(1);
    } finally {
      pmCapture.armed = false;
      engineCapture.armed = false; // R15-1: the ENGINE INJECTION is scoped to THIS leg alone — every later call delegates to the real resolveNodeEngine again
      // The e1 quit recipe: let the callback finish registering its
      // will-quit handler (bounded, best-effort — this is cleanup, never an
      // assertion), then stop the bootstrap-started host so the store
      // handle releases BEFORE the file-wide afterEach removes the temp
      // dir, and restore the env seams.
      await boundedPoll(() => (app.on as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'will-quit'), 8000);
      app.emit('will-quit');
      await new Promise((resolve) => setTimeout(resolve, 120));
      for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);

  itReal('settings-commit MUTEX, order 1 — winner first (R11-3): two CONCURRENT PUT /settings calls through the REAL server + REAL LlamaEngine + REAL production custody provider; request A succeeds through the deferred-persist gate, request B\'s persist failure rolls back. The QUEUED request\'s commit section does not BEGIN until the running request\'s section COMPLETED (B\'s first recorder event strictly after A\'s flush), and the FINAL state is exactly A\'s — responseSettings, SecretStore entries, the persisted external snapshot, live GET /settings, and EXACTLY ONE durable audit row (A\'s own); B leaves NO row (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v12 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-routes-mutex1-');
    await outboxMod!.bindOutboxBinding(ws.store, 'audit-routes-mutex1');
    const obs = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws.store));
    const secretStore = makeFakeSecretStore(); // RETAINED for the FINAL-state assertion (06 :1002: the rev-1 leg "retains no SecretStore variable")
    // CHECK_WRONG rev 17: this is a concurrency test, not an airgap-policy
    // test. Public HTTP .example.test URLs are refused (airgap or HTTPS
    // policy), so the original arrangement returned 422 before capture and
    // waited forever. The fixtures now use HTTPS with airgap disabled.
    const engine = new LlamaEngine({ externalProvider: { secretStore, airgap: false, auditSink: obs.provider } } as never);
    // The deferred-persist seam: persist call #1 (request A) PARKS on the gate;
    // call #2 (request B) rejects. The mutex must hold B's WHOLE section (not
    // just its batch) until A's section completed.
    const gateA = makeGate();
    // R12-4 REQUEST-ARRIVAL BARRIER (rev 3): the onSettingsSectionEntry seam
    // (rev-3 header item 26) fires SYNCHRONOUSLY when a request ENTERS the
    // commit section, BEFORE it awaits the mutex — the leg resolves B's
    // arrival signal and only THEN releases A, so B provably reached the
    // route while A still held the section (natural sequencing can no longer
    // masquerade as serialization).
    let bArrived!: () => void;
    const bArrival = new Promise<void>((resolve) => { bArrived = resolve; });
    let sectionEntries = 0;
    const persistedSnapshots: Array<Record<string, unknown>> = [];
    let persistCalls = 0;
    const srv = await startSettingsServer(engine, (snapshot) => {
      persistCalls += 1;
      const outcome = persistCalls === 1 ? gateA.promise : Promise.reject(new Error('external.json write failed (B probe)'));
      if (persistCalls === 1) outcome.then(() => { persistedSnapshots.push(snapshot); }).catch(() => {});
      return outcome;
    }, (section) => {
      sectionEntries += 1;
      if (section.patch['external.apiKey'] === 'sk-route-b-1') bArrived();
    });
    const putA = putSettings(srv.port, { 'external.apiKey': 'sk-route-a-1', 'external.baseUrl': 'https://route-a.example.test' });
    await obs.awaitCapture(1); // A's OWN capture — the R11-5 per-count barrier
    expect(obs.events.filter((e) => e === 'flush').length, 'request A has NOT flushed — it is parked at the deferred persist gate (capture alone never delivers)').toBe(0);
    expect(readOutboxOnFreshConnection(ws.dbPath).rows.length, 'no durable row while A is parked').toBe(0);
    const putB = putSettings(srv.port, { 'external.apiKey': 'sk-route-b-1', 'external.baseUrl': 'https://route-b.example.test' });
    await bArrival; // R12-4: B ENTERED the commit section while A still holds it — A is released only now
    expect(obs.events.filter((e) => e === 'begin').length, 'B has ENTERED but NOT begun — it is QUEUED at the settings-commit mutex while A is parked at the persist gate (the R12-4 request-arrival barrier; under the no-mutex mutant B begins immediately and the serialization assertions below go RED; plan Part 4 v13 item 3)').toBe(1);
    expect(readOutboxOnFreshConnection(ws.dbPath).rows.length, 'still no durable row while A is parked and B is queued behind the mutex').toBe(0);
    gateA.open(); // A's section completes only now — B contends with A's tail from the queue, never interleaves into it
    const resA = await putA;
    expect(resA.status, 'request A committed ok after its persist gate opened').toBe(200);
    const settingsA = (await resA.json()) as Record<string, unknown>;
    expect(settingsA['external.baseUrl'], "A's FINAL responseSettings reflect A's own commit (the winner's settings)").toBe('https://route-a.example.test');
    const resB = await putB;
    expect(resB.status, "request B's persist failure surfaces as a 500 (the outer rollback)").toBe(500);
    // THE SERIALIZATION OBSERVABLE (R11-3): B's first recorder event strictly
    // AFTER A's flush — B's commit section (beginRequest → apply → persist →
    // rollback → discard) never began inside A's section.
    expect(obs.events.filter((e) => e === 'begin').length, 'each request owned exactly ONE beginRequest batch').toBe(2);
    expect(obs.events.indexOf('begin', 1), "B's commit section did not BEGIN until A's section COMPLETED — B's beginRequest comes strictly AFTER A's flush (the settings-commit MUTEX serializes the complete apply/persist/rollback/flush section; plan Part 4 v12 item 3, R11-3)").toBeGreaterThan(obs.events.indexOf('flush'));
    expect(obs.events.filter((e) => e === 'flush').length, 'exactly ONE flush (A\'s) — B never flushed').toBe(1);
    expect(obs.events.filter((e) => e === 'discard').length, 'B\'s captured batch was DISCARDED on the outer failure branch').toBe(1);
    // FINAL STATE = exactly the successful request A's.
    const finalRows = readOutboxOnFreshConnection(ws.dbPath).rows.filter((r) => r.event === 'settings_change');
    expect(finalRows.length, 'FINAL durable set = EXACTLY A\'s own audit row (one custody envelope for the committed save; B\'s rollback left no row)').toBe(1);
    expect(finalRows[0]!.subject, 'A\'s row names the custody key').toContain('external.apiKey');
    expect([...secretStore.map.values()], 'FINAL SecretStore holds EXACTLY the winner\'s key').toContain('sk-route-a-1');
    expect([...secretStore.map.values()], 'the rolled-back request\'s key is ABSENT from the FINAL SecretStore').not.toContain('sk-route-b-1');
    expect(persistedSnapshots.length, 'exactly ONE persist actually SUCCEEDED (A\'s gate-resolved one) — B\'s rejected persist wrote nothing').toBe(1);
    expect(persistedSnapshots[0]!['external.baseUrl'], 'the PERSISTED external snapshot is the winner\'s (A\'s baseUrl)').toBe('https://route-a.example.test');
    expect((await getSettings(srv.port))['external.baseUrl'], 'FINAL LIVE settings (GET /settings) show the winner\'s value').toBe('https://route-a.example.test');
    expect(sectionEntries, 'the arrival seam fired for BOTH requests (A then B) — non-vacuous barrier (R12-4; plan Part 4 v13 item 3)').toBe(2);
  });

  itReal('settings-commit MUTEX, order 2 — the R11-3 challenge schedule (loser first): request A parks at its persist step and then FAILS; request B (persist-gated) applies through the SAME engine. Without the mutex A\'s rollback erases B\'s applied state while B\'s already-captured snapshot persists, its batch flushes, and B returns 200 over state that is gone (06 :1001) — with the mutex B\'s commit section begins strictly AFTER A\'s discard, so the FINAL state is exactly B\'s: responseSettings, SecretStore, persisted snapshot, live GET /settings, and EXACTLY ONE durable row (B\'s own); A leaves NO row (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v12 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-routes-mutex2-');
    await outboxMod!.bindOutboxBinding(ws.store, 'audit-routes-mutex2');
    const obs = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws.store));
    const secretStore = makeFakeSecretStore();
    // CHECK_WRONG rev 17: allow the public HTTPS fixture URLs; airgap policy has
    // its own executable vectors and is not the subject of this schedule.
    const engine = new LlamaEngine({ externalProvider: { secretStore, airgap: false, auditSink: obs.provider } } as never);
    // A's persist parks and will REJECT on the leg's trigger; B's persist
    // parks on a gate the leg opens only after A's section completed.
    let rejectA!: (err: Error) => void;
    const aPersist = new Promise<void>((_, reject) => { rejectA = reject; });
    const gateB = makeGate();
    // R12-4 REQUEST-ARRIVAL BARRIER (rev 3): B's entry is awaited BEFORE A
    // is failed — B provably reached the route and is queued at the mutex
    // while A still holds the section.
    let bArrived!: () => void;
    const bArrival = new Promise<void>((resolve) => { bArrived = resolve; });
    let sectionEntries = 0;
    const persistedSnapshots: Array<Record<string, unknown>> = [];
    let persistCalls = 0;
    const srv = await startSettingsServer(engine, (snapshot) => {
      persistCalls += 1;
      const outcome = persistCalls === 1 ? aPersist : gateB.promise;
      if (persistCalls === 2) outcome.then(() => { persistedSnapshots.push(snapshot); }).catch(() => {});
      return outcome;
    }, (section) => {
      sectionEntries += 1;
      if (section.patch['external.apiKey'] === 'sk-route-b2-1') bArrived();
    });
    const putA = putSettings(srv.port, { 'external.apiKey': 'sk-route-a2-1', 'external.baseUrl': 'https://route-a2.example.test' });
    await obs.awaitCapture(1); // A's OWN capture — A is parked inside its section
    const putB = putSettings(srv.port, { 'external.apiKey': 'sk-route-b2-1', 'external.baseUrl': 'https://route-b2.example.test' });
    await bArrival; // R12-4: B ENTERED the commit section while A still holds it — A is failed only now
    expect(obs.events.filter((e) => e === 'begin').length, 'B has ENTERED but NOT begun — it is QUEUED at the settings-commit mutex while A is parked at its persist step (the R12-4 request-arrival barrier; under the no-mutex mutant B begins (and applies) before A\'s discard and the serialization + final-state assertions below go RED; plan Part 4 v13 item 3)').toBe(1);
    // Fail A: its rollback (and discard) must COMPLETE before B's section may
    // BEGIN — the exact point the unserialized schedule erases B's apply.
    rejectA(new Error('external.json write failed (A2 probe)'));
    const resA = await putA;
    expect(resA.status, "A's persist failure rolls back (500)").toBe(500);
    expect(readOutboxOnFreshConnection(ws.dbPath).rows.length, 'A\'s discard left ZERO durable rows (the no-row rollback assertion, retained)').toBe(0);
    expect(obs.events.filter((e) => e === 'discard').length, 'A\'s captured batch was DISCARDED').toBe(1);
    await obs.awaitCapture(2); // B's OWN capture — the count barrier (under the mutex it can only happen after A's discard)
    const bBeginIndex = obs.events.indexOf('begin', 1);
    expect(bBeginIndex, "B's commit section did not BEGIN until A's section COMPLETED — B's beginRequest comes strictly AFTER A's discard (the serialization that makes the challenge schedule safe; plan Part 4 v12 item 3, R11-3)").toBeGreaterThan(obs.events.indexOf('discard'));
    gateB.open();
    const resB = await putB;
    expect(resB.status, 'request B committed ok after its gate opened').toBe(200);
    const settingsB = (await resB.json()) as Record<string, unknown>;
    expect(settingsB['external.baseUrl'], "B's FINAL responseSettings show B's OWN commit live — a rollback-erased apply would answer 200 over A-restored state instead (the R11-3 erasure, caught)").toBe('https://route-b2.example.test');
    // FINAL STATE = exactly the successful request B's.
    const finalRows = readOutboxOnFreshConnection(ws.dbPath).rows.filter((r) => r.event === 'settings_change');
    expect(finalRows.length, 'FINAL durable set = EXACTLY B\'s own audit row').toBe(1);
    expect(finalRows[0]!.subject, 'B\'s row names the custody key').toContain('external.apiKey');
    expect([...secretStore.map.values()], 'FINAL SecretStore holds EXACTLY the winner\'s key').toContain('sk-route-b2-1');
    expect([...secretStore.map.values()], 'the rolled-back request\'s key is ABSENT from the FINAL SecretStore').not.toContain('sk-route-a2-1');
    expect(persistedSnapshots.length, 'exactly ONE persist SUCCEEDED (B\'s) — A\'s rejected persist wrote nothing').toBe(1);
    expect(persistedSnapshots[0]!['external.baseUrl'], 'the PERSISTED external snapshot is the winner\'s (B\'s baseUrl) — under the unserialized schedule B\'s snapshot would have been computed over A-rolled-back state').toBe('https://route-b2.example.test');
    expect((await getSettings(srv.port))['external.baseUrl'], 'FINAL LIVE settings (GET /settings) show the winner\'s value').toBe('https://route-b2.example.test');
    expect(sectionEntries, 'the arrival seam fired for BOTH requests (A then B) — non-vacuous barrier (R12-4; plan Part 4 v13 item 3)').toBe(2);
  });

  itReal('applyEngineSettings ordering (backend/index.ts:932-948): the REAL NodeBackendHost outer caller — exactly ONE beginRequest batch per call, FLUSHED BEFORE the call resolves (flush event precedes the caller\'s continuation; the durable row is observable the moment the awaited call returns); a forced post-capture OUTER failure (engine.externalSnapshot throws inside the host\'s persistExternal closure) DISCARDS the batch — zero rows, flush never called (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-apply-engine-');
    await outboxMod!.bindOutboxBinding(ws.store, 'audit-apply-engine');
    const obs = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws.store));
    const engine = new LlamaEngine({ externalProvider: { secretStore: makeFakeSecretStore(), airgap: true, auditSink: obs.provider } } as never);
    const host = await startCustodyHost(engine);
    expect(typeof host.applyEngineSettings, 'the host exposes the #133 applyEngineSettings own-property seam the first-run caller drives (backend/index.ts:932-948)').toBe('function');
    const result = await host.applyEngineSettings!({ 'external.apiKey': 'sk-apply-engine-1' });
    obs.events.push('resolved'); // stamped AFTER the await — the caller's continuation
    expect(result.ok, 'the outer applyEngineSettings commit succeeded').toBe(true);
    expect(obs.events.filter((e) => e === 'begin').length, 'exactly ONE beginRequest() batch for the whole outer call (R10-4: the outer caller owns one request-scoped batch)').toBe(1);
    expect(obs.events.filter((e) => e === 'flush').length, 'exactly ONE flush for the outer call').toBe(1);
    expect(obs.events.indexOf('flush') < obs.events.indexOf('resolved'), 'the flush event PRECEDES the caller\'s continuation — the batch was flushed BEFORE the call resolved').toBe(true);
    const atContinuation = readOutboxOnFreshConnection(ws.dbPath); // same tick as the caller reading the result — zero intervening awaits
    expect(atContinuation.rows.filter((r) => r.event === 'settings_change' && r.subject.includes('external.apiKey')).length, 'the durable row is ALREADY observable at the moment the caller\'s continuation runs').toBe(1);
    // Forced post-capture OUTER failure: the host's persistExternal closure
    // calls engine.externalSnapshot (backend/index.ts:939-941) — a throwing
    // snapshot turns the persist step into the rollback class AFTER custody
    // captured. Discard, zero rows, flush never called.
    const ws2 = await openWorkspaceStore('audit-apply-engine-fail-');
    await outboxMod!.bindOutboxBinding(ws2.store, 'audit-apply-engine-fail');
    const obs2 = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws2.store));
    const failingEngine = new SnapshotThrowingEngine({ externalProvider: { secretStore: makeFakeSecretStore(), airgap: true, auditSink: obs2.provider } } as never);
    const host2 = await startCustodyHost(failingEngine);
    const failure = await host2.applyEngineSettings!({ 'external.apiKey': 'sk-apply-engine-fail' });
    expect(failure.ok, 'the forced outer failure surfaces as ok:false (the rollback path)').toBe(false);
    expect(obs2.events.filter((e) => e.startsWith('capture:')).length, 'the custody apply DID capture before the outer failure (non-vacuous control)').toBe(1);
    expect(obs2.events.filter((e) => e === 'flush').length, 'a failed outer commit NEVER flushes').toBe(0);
    expect(obs2.events.filter((e) => e === 'discard').length, 'the failed outer commit DISCARDED its captured batch').toBe(1);
    expect(readOutboxOnFreshConnection(ws2.dbPath).rows.length, 'the rolled-back outer call delivered ZERO durable rows').toBe(0);
    // REV-2 EXTENSION (R11-3): the SAME settings-commit MUTEX covers
    // applyEngineSettings — a host.applyEngineSettings call launched while a
    // PUT is PARKED inside its commit section (persist gate) cannot BEGIN its
    // own section until the PUT's COMPLETED (its beginRequest strictly after
    // the PUT's flush); both commits then land and the LATER section's value
    // is the live one.
    const ws3 = await openWorkspaceStore('audit-apply-engine-mutex-');
    await outboxMod!.bindOutboxBinding(ws3.store, 'audit-apply-engine-mutex');
    const secretStore3 = makeFakeSecretStore();
    const obs3 = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws3.store));
    const engine3 = new LlamaEngine({ externalProvider: { secretStore: secretStore3, airgap: true, auditSink: obs3.provider } } as never);
    // R12-4 REQUEST-ARRIVAL BARRIER (rev 3): the HOST's onSettingsSectionEntry
    // seam fires when the applyEngineSettings section ENTERS — the apply's
    // arrival is awaited BEFORE the parked PUT is released.
    let applyArrived!: () => void;
    const applyArrival = new Promise<void>((resolve) => { applyArrived = resolve; });
    const host3 = await startCustodyHost(engine3, (section) => {
      if (section.patch['external.apiKey'] === 'sk-mutex-apply') applyArrived();
    });
    const gatePut = makeGate();
    const srv3 = await startSettingsServer(engine3, () => gatePut.promise);
    const put = putSettings(srv3.port, { 'external.apiKey': 'sk-mutex-put' });
    await obs3.awaitCapture(1); // the PUT's OWN capture — its section is parked at the persist gate
    const applyCall = host3.applyEngineSettings!({ 'external.apiKey': 'sk-mutex-apply' }); // launched while the PUT's section is in flight
    await applyArrival; // R12-4: the apply ENTERED its commit section while the PUT still holds the mutex
    expect(obs3.events.filter((e) => e === 'begin').length, 'the applyEngineSettings section has ENTERED but NOT begun — it is QUEUED at the settings-commit mutex while the PUT is parked at its persist gate (the R12-4 request-arrival barrier extends to the applyEngineSettings contention leg; under the no-mutex mutant the apply begins before the PUT\'s flush and the serialization assertion below goes RED; plan Part 4 v13 item 3)').toBe(1);
    gatePut.open();
    expect((await put).status, 'the parked PUT committed ok after its gate opened').toBe(200);
    const applyResult = await applyCall;
    expect(applyResult.ok, 'the queued applyEngineSettings committed ok once the mutex released').toBe(true);
    expect(obs3.events.indexOf('begin', 1), 'the applyEngineSettings commit section did not BEGIN until the PUT\'s section COMPLETED — its beginRequest comes strictly AFTER the PUT\'s flush (ONE settings-commit mutex for every outer caller: PUT patch, PUT reset, applyEngineSettings, and the first-run handler; plan Part 4 v12 item 3, R11-3)').toBeGreaterThan(obs3.events.indexOf('flush'));
    expect(readOutboxOnFreshConnection(ws3.dbPath).rows.filter((r) => r.event === 'settings_change').length, 'both serialized commits landed their durable rows (exactly two)').toBe(2);
    expect([...secretStore3.map.values()], 'FINAL SecretStore holds the LATER section\'s value (the apply, serialized after the PUT)').toContain('sk-mutex-apply');
    expect([...secretStore3.map.values()], 'the earlier section\'s value was superseded by the later apply, not blended with it').not.toContain('sk-mutex-put');
  });

  itReal('first-run AWAIT ordering through the REAL IPC handler (R11-5, re-scoped rev 5 R14-1 — the production first-run patch is inference-only and emits NO custody envelope BY DESIGN, so this leg proves the AWAIT contract, never a custody row for that patch): buildFirstRunCompleteHandler (desktop/main/first-run/complete-handler.ts, rev-2 header item 25 — the extracted desktop:first-run:complete body index.ts registers at :1035-1113) is IMPORTED and DRIVEN with the caller\'s payload shape — the applied patch is the caller\'s exact {\'inference.profile\': selectedProfile} (:1093-1095); a controlled DEFERRED applyEngineSettings result proves the handler AWAITS the apply BEFORE its continuation reads .ok (while pending: no warmup, no resolution — the sync-read defect reads .ok off the pending promise, takes the error branch, resolves immediately, and FAILS both; after {ok:true}: warmup strictly after resolution, handler returns ok); the .ok===false branch through a CONTROLLED {ok:false} apply result is non-fatal (completion stands, :1096-1099) and skips warmup with NO envelope assertions (inference-only emits none by design); a profile-not-selected payload never reaches the engine; the callee-side custody FAILURE is retained with an EXTERNAL patch (forced post-capture OUTER failure through the real host: SnapshotThrowingEngine + external.apiKey → discard, zero rows) — the shipped-REGISTRATION proof is the BOOTSTRAP leg above (exactly one live registration from the REAL shipped bootstrap) beside this R12-2 registration leg, with the module-bound import existence pin below, and the INDEX-SUPPLIED custody chain is the bootstrap leg\'s external.apiKey commit (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v12 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const handlerMod = (await import('../../main/first-run/complete-handler.js').catch(() => null)) as unknown as FirstRunHandlerModule | null;
    expect(handlerMod, 'the extracted first-run completion handler desktop/main/first-run/complete-handler.ts must exist (rev-2 header item 25; plan Part 4 v12 item 3, R11-5: the first-run ordering is driven through the REAL desktop:first-run:* handler, not a caller-supplied await; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof handlerMod!.buildFirstRunCompleteHandler, 'the handler factory has the name this spec DECLARES (rev-2 header item 25): buildFirstRunCompleteHandler').toBe('function');
    // (a) SUCCESS — the AWAIT proof through a controlled DEFERRED apply (rev
    // 5, R14-1): the production first-run patch is inference-only
    // ({'inference.profile': selectedProfile}) and by design NEVER enters the
    // ExternalProviderState custody capture (batch.capture threads
    // exclusively into external save/clear/reset — issue scope is API-key
    // custody), so this leg proves the handler's AWAIT/REGISTRATION contract
    // with NO custody-row assertion for that patch. The sync-read defect
    // reads `.ok` off the PENDING promise (a promise is never .ok:false),
    // takes the error branch, resolves immediately, and never warms up — it
    // fails the pending assertions below. The durable-row form of the
    // awaited contract (a custody key through the identical
    // host.applyEngineSettings callee) is asserted in the applyEngineSettings
    // leg above with an EXTERNAL key.
    const appliedPatches: Array<Record<string, unknown>> = [];
    let warmups = 0;
    const order: string[] = [];
    let releaseApply!: (result: { ok: true }) => void;
    const deferredApply = new Promise<{ ok: true }>((resolve) => { releaseApply = resolve; });
    const handler = handlerMod!.buildFirstRunCompleteHandler({
      completeWizard: async () => {},
      backendHost: { applyEngineSettings: (patch: Record<string, unknown>) => { appliedPatches.push(patch); return deferredApply; } },
      engine: { warmup: () => { order.push('warmup'); warmups += 1; } },
    });
    const resultPromise = handler({ selectedProfile: 'quality', acknowledgedLicenses: true });
    let resultSettled = false;
    void resultPromise.then(() => { resultSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25)); // a real macrotask boundary: any sync-read mutant settles inside microtasks long before this
    expect(warmups, 'while the apply is PENDING the handler has NOT run the warmup (plan Part 4 v15 item 3, R14-1)').toBe(0);
    expect(resultSettled, 'the handler did NOT resolve before applyEngineSettings resolved — it AWAITS the apply before reading .ok; the sync-read defect reads `.ok` off the PENDING promise, takes the error branch, and resolves immediately — it FAILS exactly this assertion (plan Part 4 v15 item 3, R14-1)').toBe(false);
    releaseApply({ ok: true }); order.push('apply-resolved');
    const result = await resultPromise;
    expect(result.ok, 'the real handler completed ok for a valid payload once the apply resolved { ok: true }').toBe(true);
    expect(appliedPatches.length, 'the handler drove the engine seam EXACTLY ONCE').toBe(1);
    expect(appliedPatches[0]!['inference.profile'], "the applied patch is the caller's exact one — { 'inference.profile': selectedProfile } (index.ts:1093-1095)").toBe('quality');
    expect(warmups, 'the warmup fired ONLY AFTER the deferred apply resolved — the sync-read mutant takes the error branch off the pending promise and NEVER warms up, failing exactly this assertion (index.ts:1101-1105; plan Part 4 v15 item 3, R14-1)').toBe(1);
    expect(order, 'the warmup ran STRICTLY AFTER the apply resolution — [apply-resolved, warmup], never the reverse (plan Part 4 v15 item 3, R14-1)').toEqual(['apply-resolved', 'warmup']);
    // (b) the .ok===false BRANCH through a CONTROLLED failing apply result
    // (rev 5, R14-1 — the critic's Required change names exactly this
    // injection pattern for the registration branch, and the handler branch
    // already used it): the handler AWAITED a failing (promise-returning)
    // apply — non-fatal (completion stands, index.ts:1096-1099), warmup
    // skipped. NO discard/zero-row assertions here: the inference-only patch
    // emits NO envelope by design. (The sync-read DISCRIMINATOR is the
    // deferred (a) above; this branch pins the awaited ok:false semantics.)
    let warmups2 = 0;
    const handler2 = handlerMod!.buildFirstRunCompleteHandler({
      completeWizard: async () => {},
      backendHost: { applyEngineSettings: async () => ({ ok: false, status: 500, detail: 'probe refusal' }) },
      engine: { warmup: () => { warmups2 += 1; } },
    });
    const failed = await handler2({ selectedProfile: 'fast', acknowledgedLicenses: true });
    expect(failed.ok, 'the failed engine apply is NON-FATAL — the handler logs and completion stands (index.ts:1096-1099 returns ok:true)').toBe(true);
    expect(warmups2, 'the .ok===false branch SKIPPED the warmup — the handler observed the AWAITED ok:false result (a synchronous .ok read on the promise would have taken the success branch and warmed up)').toBe(0);
    // (c) profile-not-selected: the refusal happens BEFORE any engine work
    // (index.ts:1043-1054) with the base reason literal.
    const handler3 = handlerMod!.buildFirstRunCompleteHandler({
      completeWizard: () => { throw new Error('must not be reached'); },
      backendHost: { applyEngineSettings: () => { throw new Error('must not be called'); } },
      engine: {},
    });
    const refused = await handler3({ selectedProfile: 'bogus', acknowledgedLicenses: true });
    expect(refused.ok, 'an invalid selectedProfile refuses without any engine work (index.ts:1043-1054)').toBe(false);
    if (!refused.ok) expect(refused.reason, 'the refusal carries the base reason literal (index.ts:1052)').toBe('profile-not-selected');
    // (d) the callee-side failure path, retained from rev 1: a forced
    // post-capture OUTER failure through the REAL host with a custody key —
    // the failed commit DISCARDS its batch, zero durable rows.
    const ws2 = await openWorkspaceStore('audit-first-run-fail-');
    await outboxMod!.bindOutboxBinding(ws2.store, 'audit-first-run-fail');
    const obs2 = makeObservedProvider(outboxMod!.createProductionCustodySink(() => ws2.store));
    const failingEngine = new SnapshotThrowingEngine({ externalProvider: { secretStore: makeFakeSecretStore(), airgap: true, auditSink: obs2.provider } } as never);
    const host2 = await startCustodyHost(failingEngine);
    const failedApplied = await host2.applyEngineSettings!({ 'external.apiKey': 'sk-first-run-fail' });
    expect(failedApplied.ok, 'the failed first-run apply reports ok:false to the caller').toBe(false);
    expect(obs2.events.filter((e) => e === 'discard').length, 'the failed first-run apply DISCARDED its captured batch').toBe(1);
    expect(readOutboxOnFreshConnection(ws2.dbPath).rows.length, 'the failed first-run apply left ZERO durable rows').toBe(0);
    // (e) REV 16 (plan Part 4 v27): the rev-2 identifier-scan AST pin that once
    // lived here is RETIRED HISTORY — 06 :1063-1069 executed its logic on the
    // uncalled-factory and if (false) registrations and got pinPasses=true both
    // times. The shipped-registration proof is BEHAVIORAL: the BOOTSTRAP leg
    // above executes the REAL bootstrap and asserts EXACTLY ONE live
    // desktop:first-run:complete registration (a duplicate registration fails
    // there; an inline handler kept INSTEAD of calling the extracted function
    // fails the source-level pin below) beside
    // this REGISTRATION-EXECUTION leg; the source-level pin at the end of the file
    // adds module-bound import existence and the source census.
  });

  itReal('first-run REGISTRATION executed with the REAL Electron (event, payload) SIGNATURE (R12-2 + R13-3, re-scoped rev 5 R14-1 — the production first-run patch is inference-only and emits NO custody envelope BY DESIGN, so the registration leg proves REGISTRATION + AWAIT semantics through CONTROLLED dependencies, never a custody row/discard/zero-row assertion for that patch; the rev-4 SnapshotThrowingEngine failure arrangement could not fire on an inference-only patch — 06 :1185-1191): registerFirstRunCompleteIpc (desktop/main/first-run/complete-handler.ts, rev-3 header item 25b + the rev-4 adapter) is IMPORTED and driven with a RECORDING FAKE ipcMain — EXACTLY ONE registration for desktop:first-run:complete; the captured callback is NOT the factory itself (the uncalled-factory shape); INVOKING the captured callback as captured(null, payload) — the REAL Electron invocation shape, the e1-packaged-glue-hardening precedent (`ipcMain.handle handlers receive (event, payload)`) — drives a controlled DEFERRED applyEngineSettings result (while pending: no warmup, no resolution — the sync-read defect reads .ok off the pending promise, takes the error branch, resolves immediately, and FAILS both; after {ok:true}: warmup strictly after resolution), the .ok===false branch through a CONTROLLED {ok:false} apply result (non-fatal, warmup skipped, NO envelope assertions — inference-only emits none by design), and the profile-not-selected refusal; a one-argument product registered DIRECTLY (no adapter) receives null as payload here and fails the valid-payload legs (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v15 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const handlerMod = (await import('../../main/first-run/complete-handler.js').catch(() => null)) as unknown as FirstRunHandlerModule | null;
    expect(handlerMod, 'the extracted first-run completion handler desktop/main/first-run/complete-handler.ts must exist (rev-3 header item 25b; plan Part 4 v15 item 3, R12-2: the registration is driven through the REAL extracted registration function, not a text pin; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof handlerMod!.registerFirstRunCompleteIpc, 'the registration export has the name this spec DECLARES (rev-3 header item 25b): registerFirstRunCompleteIpc').toBe('function');
    // The RECORDING FAKE ipcMain: an object with a handle(channel, cb)
    // recorder — the ONLY Electron surface the extracted registration needs.
    const registrations: Array<{ channel: string; callback: unknown }> = [];
    const fakeIpc: { handle(channel: string, callback: unknown): void } = {
      handle: (channel: string, callback: unknown): void => { registrations.push({ channel, callback }); },
    };
    // CONTROLLED dependencies (rev 5, R14-1): a DEFERRED applyEngineSettings
    // result — the AWAIT discriminator. The rev-4 leg routed the registered
    // callback into a REAL host whose inference-only apply SUCCEEDS (and the
    // SnapshotThrowingEngine failure arm never fires without an `external.`
    // key), so it could prove neither the await nor the failure branch; the
    // durable-row custody chain through a REAL host is proven with an
    // EXTERNAL key in the applyEngineSettings leg and the bootstrap leg.
    const appliedPatches: Array<Record<string, unknown>> = [];
    let warmups = 0; let completions = 0;
    const order: string[] = [];
    let releaseApply!: (result: { ok: true }) => void;
    const deferredApply = new Promise<{ ok: true }>((resolve) => { releaseApply = resolve; });
    handlerMod!.registerFirstRunCompleteIpc(fakeIpc, {
      completeWizard: async () => { completions += 1; },
      backendHost: { applyEngineSettings: (patch: Record<string, unknown>) => { appliedPatches.push(patch); return deferredApply; } },
      engine: { warmup: () => { order.push('warmup'); warmups += 1; } },
    });
    expect(registrations.length, 'the REAL registration performed EXACTLY ONE ipc.handle call — a duplicate registration (two calls) fails here (R12-2; plan Part 4 v15 item 3)').toBe(1);
    expect(registrations[0]!.channel, 'the one registration is for the exact channel').toBe('desktop:first-run:complete');
    const captured = registrations[0]!.callback as (event: unknown, payload: unknown) => Promise<FirstRunCompleteResult>;
    expect(typeof captured, 'the registered callback is a FUNCTION (a channel + callable pair)').toBe('function');
    expect(captured, 'the registered callback is NOT buildFirstRunCompleteHandler ITSELF — the registration must CALL the factory and register the RESULTING handler; ipc.handle(ch, factory) with ZERO factory calls is the R12-2 uncalled-factory mutant and fails this identity assertion (plan Part 4 v15 item 3)').not.toBe(handlerMod!.buildFirstRunCompleteHandler);
    // INVOKING the captured callback — the REAL Electron shape
    // captured(null, payload): Electron dispatches ipcMain.handle callbacks
    // as (event, ...args), so the registration must ADAPT (the rev-4 header
    // item 25b adapter `(_event, payload) => handler(payload)`). A
    // one-argument product registered DIRECTLY receives null as payload,
    // selectedProfile is absent, and the valid-payload legs below fail as
    // profile-not-selected refusals (R13-3).
    const resultPromise = captured(null, { selectedProfile: 'quality', acknowledgedLicenses: true });
    let resultSettled = false;
    void resultPromise.then(() => { resultSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25)); // a real macrotask boundary: any sync-read mutant settles inside microtasks long before this
    expect(warmups, 'while the DEFERRED apply is PENDING the registered handler has NOT run the warmup (plan Part 4 v15 item 3, R14-1)').toBe(0);
    expect(resultSettled, 'the REGISTERED handler did NOT resolve before applyEngineSettings resolved — it AWAITS the apply before reading .ok; the sync-read defect reads `.ok` off the pending promise, takes the error branch, and resolves immediately — it FAILS exactly this assertion (invoked as captured(null, payload), the REAL Electron dispatch; plan Part 4 v15 item 3, R14-1)').toBe(false);
    releaseApply({ ok: true }); order.push('apply-resolved');
    const result = await resultPromise;
    expect(result.ok, 'the REGISTERED handler completed ok for a valid payload invoked as captured(null, payload) once the deferred apply resolved — the REAL Electron (event, payload) dispatch; the one-argument-direct-product mutant receives null as payload here and is refused profile-not-selected, failing exactly this assertion (R13-3; plan Part 4 v15 item 3)').toBe(true);
    expect(completions, 'the registered handler persisted the wizard completion EXACTLY ONCE').toBe(1);
    expect(appliedPatches.length, 'the registered handler drove the engine seam EXACTLY ONCE').toBe(1);
    expect(appliedPatches[0]!['inference.profile'], "the applied patch is the caller's exact one — { 'inference.profile': selectedProfile } (index.ts:1093-1095)").toBe('quality');
    expect(warmups, 'the warmup fired ONLY AFTER the deferred apply resolved — the sync-read mutant takes the error branch off the pending promise and NEVER warms up, failing exactly this assertion (index.ts:1101-1105; plan Part 4 v15 item 3, R14-1)').toBe(1);
    expect(order, 'the warmup ran STRICTLY AFTER the apply resolution through the REGISTERED handler — [apply-resolved, warmup], never the reverse (plan Part 4 v15 item 3, R14-1)').toEqual(['apply-resolved', 'warmup']);
    // Payload validation THROUGH the registered callback: a bad
    // selectedProfile refuses BEFORE any engine work (invoked with the
    // REAL (event, payload) shape — the refusal arm reads the payload from
    // the SECOND argument).
    const refused = await captured(null, { selectedProfile: 'bogus', acknowledgedLicenses: true });
    expect(refused.ok, 'an invalid selectedProfile refuses through the REGISTERED handler (index.ts:1043-1054)').toBe(false);
    if (!refused.ok) expect(refused.reason, 'the refusal carries the base reason literal (index.ts:1052)').toBe('profile-not-selected');
    expect(appliedPatches.length, 'the refusal NEVER reached the engine (still exactly one applied patch)').toBe(1);
    expect(completions, 'the refusal never persisted a completion (still exactly one)').toBe(1);
    // The .ok===false branch THROUGH a registered callback (rev 5, R14-1): a
    // second fake ipc + a CONTROLLED {ok:false} apply result — exactly the
    // injection pattern the critic's Required change names for this branch.
    // The handler stays non-fatal with warmup skipped; NO discard/zero-row
    // assertions (the inference-only patch emits NO envelope by design —
    // the real-host custody FAILURE with an EXTERNAL patch lives in the
    // applyEngineSettings leg and the handler leg's retained sub-leg).
    const registrations2: Array<{ channel: string; callback: unknown }> = [];
    const fakeIpc2: { handle(channel: string, callback: unknown): void } = {
      handle: (channel: string, callback: unknown): void => { registrations2.push({ channel, callback }); },
    };
    let warmups2 = 0;
    handlerMod!.registerFirstRunCompleteIpc(fakeIpc2, {
      completeWizard: async () => {},
      backendHost: { applyEngineSettings: async () => ({ ok: false, status: 500, detail: 'probe refusal' }) },
      engine: { warmup: () => { warmups2 += 1; } },
    });
    expect(registrations2.length, 'the second registration likewise performed EXACTLY ONE ipc.handle call').toBe(1);
    const failed = await (registrations2[0]!.callback as (event: unknown, payload: unknown) => Promise<FirstRunCompleteResult>)(null, { selectedProfile: 'fast', acknowledgedLicenses: true });
    expect(failed.ok, 'the .ok===false engine apply is NON-FATAL through the registered handler (completion stands, index.ts:1096-1099) — invoked as captured(null, payload), the REAL Electron dispatch, over a CONTROLLED {ok:false} apply result (R13-3 + R14-1; plan Part 4 v15 item 3)').toBe(true);
    expect(warmups2, 'the .ok===false branch SKIPPED the warmup through the registered handler — the handler observed the AWAITED ok:false result (a synchronous .ok read on the promise would have taken the same error branch only by accident; the (a)-deferred proof above is the discriminator; plan Part 4 v15 item 3, R14-1)').toBe(0);
  });

  it('source-level pin: MODULE-BOUND import existence + SOURCE CENSUS (rev 17, plan Part 4 v27). (a) the REAL desktop/main/index.ts statically imports registerFirstRunCompleteIpc from the EXACT expected module desktop/main/first-run/complete-handler.ts — the ImportDeclaration binding\'s module specifier must RESOLVE to that exact file (a same-named import from ./wrong.js FAILS; a deleted/unresolvable complete-handler.ts FAILS CLOSED — name-only matching is forbidden, R13-2). (b) SOURCE CENSUS — the name registerFirstRunCompleteIpc occurs as a USAGE (an identifier outside import/export binding positions, or a whole string literal equal to the name) EXACTLY ONCE across every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs source file of the repository outside node_modules, .git, .agents, dist, out, build, coverage, __tests__, tests, test, and e2e — the defining module excluded — and that ONE usage is a DIRECT CALL in index.ts. SCOPE OF THE EXACTLY-ONCE CLAIM: this is a claim about the SHIPPED SOURCE TEXT. The pin is SYNTACTIC (a dead direct call is still one literal usage and passes it; REACHABILITY is not claimed). Whether the registration is LIVE and SINGLE is proven executably by the BOOTSTRAP leg of this file (exactly one live registration from the REAL bootstrap). NOT CLAIMED, by design: an invocation synthesized at RUNTIME by dynamic code evaluation or by a separately loaded module instance, AND a usage spelled under ANOTHER NAME (an aliased import of the target, or an alias export of the defining module called elsewhere — the census is a census of the literal spelling) — no acceptance criterion of #372 or #373 requires it, so it is not a check concern (the implementation diff is reviewed in Phase 4.5/4.6) (audit-outbox-custody-routes)', () => {
    const indexPath = path.join(REPO_ROOT, 'desktop', 'main', 'index.ts');
    expect(fs.existsSync(indexPath), 'the real desktop/main/index.ts source must exist for the source-level pin to check (plan Part 4 v27)').toBe(true);
    const program = buildIndexProgram(indexPath);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(indexPath);
    expect(sf, 'the checker program must include the real desktop/main/index.ts source file').toBeDefined();
    const expectedModule = path.join(REPO_ROOT, 'desktop', 'main', 'first-run', 'complete-handler.ts');
    const targetSymbol = findModuleBoundImportedSymbol(sf!, checker, 'registerFirstRunCompleteIpc', expectedModule);
    expect(targetSymbol, 'index.ts must IMPORT registerFirstRunCompleteIpc MODULE-BOUND — the binding\'s module specifier must RESOLVE to the exact expected file desktop/main/first-run/complete-handler.ts (the pre-fix file holds ZERO registerFirstRunCompleteIpc references: RED at base; a same-named import from ./wrong.js FAILS here (wrong-module mutant); a deleted/unresolvable complete-handler.ts FAILS CLOSED here (unresolved-module mutant) — name-only matching is forbidden; R13-2, plan Part 4 v27)').toBeDefined();
    // (b) SOURCE CENSUS (plan Part 4 v27): exactly one USAGE in the production source text, a direct call in index.ts.
    const describeUsage = (u: { file: string; isDirectCall: boolean }): string => `${path.relative(REPO_ROOT, u.file).split(path.sep).join('/')} ${u.isDirectCall ? '(direct call)' : '(NOT a direct call)'}`;
    const usages = collectNameUsages('registerFirstRunCompleteIpc', expectedModule);
    expect(usages.length, `the name registerFirstRunCompleteIpc is USED exactly ONCE across the repository production source text — SOURCE CENSUS (plan Part 4 v27); got ${String(usages.length)}${usages.length === 0 ? '' : `: ${usages.map(describeUsage).join(', ')}`}`).toBe(1);
    expect(path.resolve(usages[0]!.file), 'the ONE usage of registerFirstRunCompleteIpc sits in desktop/main/index.ts').toBe(path.resolve(indexPath));
    expect(usages[0]!.isDirectCall, 'the ONE usage of registerFirstRunCompleteIpc is a DIRECT CALL — the callee of a call expression').toBe(true);
  }, 60000);

  itReal('legacy-sink adapter (R10-4 + R11-5): the production factory accepts a PLAIN { capture, flush, discard } sink (no beginRequest) — adaptLegacyCustodySink wraps it as ONE-SHOT forwarding batches (capture→sink.capture, flush→sink.flush, discard→sink.discard, per beginRequest), passes a beginRequest provider through, and the REAL LlamaEngine constructed with a PLAIN legacy-shaped sink drives TWO SEQUENTIAL real PUT saves → two one-shot batches (capture/flush TWICE) → EXACTLY TWO durable rows; legacy OVERLAP is serialized by the SAME settings-commit mutex (the mutex lives at the route/host layer, so it covers legacy-shaped sinks too) — sequential reuse is the SUPPORTED contract this pins — the executable proof the two older frozen C4 specs need NO amendment (audit-outbox-custody-routes)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as RoutesOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof outboxMod!.adaptLegacyCustodySink, 'the legacy-sink adapter has the name this spec DECLARES (header item 22): adaptLegacyCustodySink — the plan requires "the factory accepts EITHER beginRequest() sinks OR a plain { capture, flush, discard } object" without naming it').toBe('function');
    // (a) the plain shape wrapped as one-shot forwarding batches.
    const forwarded: string[] = [];
    const plain = { capture: (): void => { forwarded.push('capture'); }, flush: (): void => { forwarded.push('flush'); }, discard: (): void => { forwarded.push('discard'); } };
    expect(typeof (plain as { beginRequest?: unknown }).beginRequest, 'the plain sink carries NO beginRequest — the exact legacy shape the two older frozen specs inject').toBe('undefined');
    const adapted = outboxMod!.adaptLegacyCustodySink(plain);
    expect(typeof adapted.beginRequest, 'the adapter returns the request-scoped beginRequest() view over the plain sink').toBe('function');
    const b1 = adapted.beginRequest();
    b1.capture({ eventId: 'legacy-adapter-1', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await b1.flush();
    const b2 = adapted.beginRequest();
    b2.capture({ eventId: 'legacy-adapter-2', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    b2.discard();
    expect(forwarded, 'each one-shot batch forwarded EXACTLY its own calls to the plain sink (capture→flush for the first request, capture→discard for the second)').toEqual(['capture', 'flush', 'capture', 'discard']);
    // (b) a beginRequest provider passes through the same adapter.
    const ws = await openWorkspaceStore('audit-legacy-adapter-');
    await outboxMod!.bindOutboxBinding(ws.store, 'audit-legacy-adapter');
    const provider = outboxMod!.createProductionCustodySink(() => ws.store);
    const passThrough = outboxMod!.adaptLegacyCustodySink(provider);
    const pb = passThrough.beginRequest();
    pb.capture({ eventId: 'legacy-adapter-passthrough', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await pb.flush();
    expect(readOutboxOnFreshConnection(ws.dbPath).rows.filter((r) => r.event_id === 'legacy-adapter-passthrough').length, 'the pass-through path still lands its durable row through the REAL provider').toBe(1);
    // (c) END-TO-END legacy proof: the REAL LlamaEngine with a PLAIN sink
    // (legacy shape — indistinguishable from the older specs' recorders),
    // forwarding into the REAL provider's batch, through the real PUT route.
    const legacyCalls: string[] = [];
    let legacyPending: DesktopAuditEnvelope[] = [];
    // CHECK_WRONG rev 17: a plain legacy sink is stateless across requests.
    // The old arrangement forwarded every request into ONE provider batch;
    // after the first flush that batch was spent, so the second request could
    // never land a row. Each flush now acquires a fresh provider batch.
    const legacySink = {
      capture: (envelope: DesktopAuditEnvelope): void => { legacyCalls.push('capture'); legacyPending.push(envelope); },
      flush: async (): Promise<void> => {
        legacyCalls.push('flush');
        if (legacyPending.length === 0) return;
        const batch = provider.beginRequest();
        for (const envelope of legacyPending) batch.capture(envelope);
        legacyPending = [];
        await batch.flush();
      },
      discard: (): void => { legacyCalls.push('discard'); legacyPending = []; },
    };
    const engine = new LlamaEngine({ externalProvider: { secretStore: makeFakeSecretStore(), airgap: true, auditSink: legacySink } } as never);
    const srv = await startSettingsServer(engine, () => {});
    const res = await putSettings(srv.port, { 'external.apiKey': 'sk-legacy-adapter-e2e' });
    expect(res.status, 'the real PUT /settings save committed ok through the legacy-shaped sink').toBe(200);
    expect(legacyCalls, 'the engine\'s custody layer drove the PLAIN sink with the exact legacy call order (capture during apply, flush on outer success)').toEqual(['capture', 'flush']);
    expect(readOutboxOnFreshConnection(ws.dbPath).rows.filter((r) => r.event_id !== 'legacy-adapter-passthrough').length, 'one save through the legacy-shaped sink = EXACTLY ONE new durable row (besides the arrange pass-through row) — the adapter closes R10-4\'s frozen-caller conflict, which is why audit-desktop-producer.test.ts and audit-outbox-composition.test.ts stay byte-equivalent with no amendment').toBe(1);
    // (d) REV-2 EXTENSION (R11-5): TWO SEQUENTIAL real PUTs through the SAME
    // legacy-shaped sink — one-shot batch per outer call, capture/flush twice,
    // exactly two durable rows. Legacy OVERLAP is serialized by the SAME
    // settings-commit mutex (route/host layer — it covers legacy-shaped sinks
    // too); SEQUENTIAL reuse is the supported contract pinned here.
    const res2 = await putSettings(srv.port, { 'external.apiKey': 'sk-legacy-adapter-e2e-2' });
    expect(res2.status, 'the SECOND sequential PUT through the same legacy-shaped sink committed ok').toBe(200);
    expect(legacyCalls, 'two sequential outer calls = TWO one-shot batches: capture/flush TWICE through the plain sink (the batch is spent per request, never reused across requests)').toEqual(['capture', 'flush', 'capture', 'flush']);
    const finalLegacyRows = readOutboxOnFreshConnection(ws.dbPath).rows.filter((r) => r.event_id !== 'legacy-adapter-passthrough');
    expect(finalLegacyRows.length, 'TWO sequential legacy PUTs = EXACTLY TWO durable rows — one per committed outer call (no batch reuse across requests, no lost second row; plan Part 4 v12 item 3, R11-5)').toBe(2);
    expect(new Set(finalLegacyRows.map((r) => r.event_id)).size, 'each request\'s row carries its own eventId').toBe(2);
  });
});
