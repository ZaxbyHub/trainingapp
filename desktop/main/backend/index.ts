// Backend host selector — THE import seam for B4-B9 (issue #61).
//
// `createBackendHost(config)` returns ONE of two implementations behind the
// SAME BackendHost interface, chosen only by the resolved backend.mode:
//   - "node" (default while ADR-0003 #57 is open): the guarded listener
//     serves the frozen contract from the local StubEngine.
//   - "sidecar": the SAME guarded listener fronts a transparent proxy to a
//     spawned backend child managed by SidecarManager.
// Flipping the default when ADR-0003 lands is a one-line change in types.ts.
//
// Electron-free: safe to import from the headless dev-server entry and CI.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopbackGuard } from '../security/loopback-guard.js';
import { DEFAULT_ALLOWED_ORIGINS, DEV_ORIGINS_ENV } from '../security/defaults.js';
import { resolveNodeEngine } from './inference/llama-engine.js';
import { SidecarManager } from './sidecar-manager.js';
import { createBackendServer, listenOnRandomPort } from './server.js';
import { closeStore, openStore, type StoreHandle } from './store/sqlite-store.js';
import { checkStoreIntegrity, recoverStore } from './store/recovery.js';
import { createBackup } from './store/backup.js';
import { StoreDocumentSurface } from './store/document-surface.js';
import { loadSettingsSnapshot, saveSettingsSnapshot } from './settings-store.js';
import { OnnxEmbedder, resolveEmbedder, type EmbeddingSurface } from './ingest/embedder.js';
import { resolveIngestConfig, resolveIngestLimits } from './ingest/config.js';
import { createRetrievalSurface, type RetrievalSurface } from './retrieval/hybrid.js';
import { resolveRetrievalConfig } from './retrieval/config.js';
import {
  resolveRerankerModelDir,
  ResumableReranker,
  WorkerEmbedder,
  WorkerReranker,
  type RerankerSurface,
  type WorkerMemoryReport,
} from './retrieval/reranker.js';
import {
  createPressureMonitor,
  resolveConcurrencyConfig,
  resolveMemoryConfig,
  resolveWorkerPoolConfig,
  type MemoryComponent,
  type PressureMonitor,
} from './memory/budget.js';
import { createMemoryTelemetry, type MemoryTelemetry } from './memory/telemetry.js';
import { ConcurrencyScheduler } from './memory/scheduler.js';
import { IdleUnloadController } from './memory/idle-unload.js';
import {
  resolveBackendMode,
  type BackendHandle,
  type BackendHost,
  type BackendHostConfig,
  type BackendMode,
  type EngineSurface,
} from './types.js';

export type { BackendHandle, BackendHost, BackendHostConfig, BackendMode };
export { resolveBackendMode, resolveNodeEngine };

/**
 * Reserve a free loopback port for a child process: bind port 0, read the
 * assigned port, close. The brief bind-close race is acceptable here because
 * the port is handed to a child we spawn immediately (documented in
 * docs/security/desktop.md).
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address !== 'string' ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not reserve a free loopback port'));
      });
    });
  });
}

/**
 * Node-mode host: guarded listener + the B4 real inference engine
 * (resolveNodeEngine: LlamaEngine by default; the B3 StubEngine survives only
 * as the explicit TRAININGAPP_DESKTOP_ENGINE=stub dev/CI fixture).
 */
export class NodeBackendHost implements BackendHost {
  readonly mode: BackendMode = 'node';
  private server: ReturnType<typeof createBackendServer> | null = null;
  private handle: BackendHandle | null = null;
  private store: StoreHandle | null = null;
  private surface: StoreDocumentSurface | null = null;
  private retrieval: RetrievalSurface | null = null;
  private reranker: RerankerSurface | null = null;
  /** The embedder resolved for ingest — B7 reuses the SAME instance for query embedding. */
  private embedder: EmbeddingSurface | null = null;
  // ---- B8 memory/concurrency governance (issue #66). All new members are
  // INSTANCE FIELDS, deliberately never prototype methods: the b3 duck-type
  // pin requires both host prototypes to expose exactly start/stop.
  private scheduler: ConcurrencyScheduler | null = null;
  private telemetry: MemoryTelemetry | null = null;
  private monitor: PressureMonitor | null = null;
  private idle: IdleUnloadController | null = null;
  private resumable: ResumableReranker | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private workerMemory: WorkerMemoryReport | null = null;
  private embedsViaWorker = false;
  private rssBaselineBytes = 0;
  private downgradeLatched = false;
  private recoveryEmitted = false;

  /** Per-component RSS provider for the telemetry snapshot (bytes). */
  private rssFor = (component: MemoryComponent): number => {
    if (component === 'chromium') return process.memoryUsage().rss;
    if (component === 'llm') {
      // Baseline-relative increment: dominated by the resident llama model
      // (native heap inside the main process; attribution documented in
      // docs/adr/0008-memory-budget.md).
      return Math.max(0, process.memoryUsage().rss - this.rssBaselineBytes);
    }
    if (component === 'rerankerSession') {
      return this.workerMemory === null ? 0 : this.workerMemory.external + this.workerMemory.arrayBuffers;
    }
    if (component === 'embeddingSession') {
      // The embed session shares the SAME single ORT thread when ingest
      // embeddings are worker-proxied (B7 WorkerEmbedder); 0 otherwise
      // (hash embedder or main-thread fixture — nothing measurable to own).
      return this.embedsViaWorker && this.workerMemory !== null
        ? this.workerMemory.external + this.workerMemory.arrayBuffers
        : 0;
    }
    if (component === 'sqlite') {
      const store = this.store;
      if (store === null) return 0;
      const db = store.db as unknown as { memoryUsed?: () => number };
      return typeof db.memoryUsed === 'function' ? db.memoryUsed() : 0;
    }
    return 0;
  };

  /** One sampler tick: refresh worker memory, sample, observe, decide. */
  private memoryTick = async (): Promise<void> => {
    const monitor = this.monitor;
    const scheduler = this.scheduler;
    if (monitor === null || scheduler === null) return;
    this.workerMemory = this.resumable !== null ? await this.resumable.reportMemory() : null;
    const snapshot = this.telemetry?.sample() ?? null;
    monitor.observe(os.freemem(), Date.now());
    const status = monitor.evaluate();
    const engineOverride = this.engine as { setProfileOverride?: (profile: 'quality' | 'fast' | null) => void };
    if (status.downgraded && !this.downgradeLatched) {
      this.downgradeLatched = true;
      engineOverride.setProfileOverride?.('fast');
      const freeMemMb = snapshot?.systemFreeMb ?? 0;
      console.error(
        `[trainingapp-backend] memory pressure: free RAM ${freeMemMb.toFixed(0)} MB sustained below threshold; downgrading inference profile to fast`,
      );
      this.config.onMemoryEvent?.({
        type: 'downgrade',
        effectiveProfile: 'fast',
        freeMemMb,
        detail: 'sustained free-RAM pressure below memory.pressureThresholdGb',
      });
    }
    if (status.recoveryEligible && !this.recoveryEmitted) {
      this.recoveryEmitted = true;
      this.config.onMemoryEvent?.({
        type: 'recovery-eligible',
        detail: 'free RAM recovered above the threshold for the sustained recovery window',
      });
    }
    // AC3 (issue #66): the ONLY upgrade path — the override clears when the
    // recovery is eligible AND no generation is running or queued (checked
    // between generations; bounded staleness = one telemetry interval).
    if (
      this.downgradeLatched &&
      status.recoveryEligible &&
      scheduler.generationInFlight === false &&
      scheduler.queueDepth === 0 &&
      scheduler.activeGenerations === 0
    ) {
      this.downgradeLatched = false;
      this.recoveryEmitted = false;
      engineOverride.setProfileOverride?.(null);
      // Acknowledge the upgrade on the monitor: without this the never-reset
      // `downgraded` latch re-latched 'fast' on the very next tick (fast/
      // quality oscillation + event spam; PR-review finding PRR-F1, pinned by
      // b8-host-loop.test.ts).
      monitor.resetAfterUpgrade();
      this.config.onMemoryEvent?.({
        type: 'telemetry',
        effectiveProfile: 'quality',
        detail: 'profile override cleared between generations (recovery sustained)',
      });
    }
  };

  /**
   * B6 (issue #64): snapshot the open store into <backupsDir>/<timestamp>/
   * (WAL-flushed; restore validates schema+dims). Own property BY DESIGN: the
   * b3 duck-type pin requires both host prototypes to expose exactly
   * start/stop — node-only capabilities must stay off the prototype.
   */
  createStoreBackup = async (
    backupsDir: string,
  ): Promise<{ ok: true; path: string; bytes: number } | { ok: false; detail: string }> => {
    const store = this.store;
    if (store === null) return { ok: false, detail: 'no store is open (store disabled or recovery in progress)' };
    try {
      const result = createBackup(store, backupsDir);
      return { ok: true, path: result.path, bytes: result.bytes };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };

  constructor(
    private readonly config: BackendHostConfig,
    private readonly engine: EngineSurface = config.engine ?? resolveNodeEngine(config.env ?? process.env),
  ) {}

  async start(): Promise<BackendHandle> {
    if (this.handle) return this.handle;
    // B8 (issue #66): resolve the memory/concurrency budget and build the
    // governance stack BEFORE the listener exists, so /telemetry/memory and
    // the generation mutex are live from the first request.
    const env = this.config.env ?? process.env;
    const memoryConfig = resolveMemoryConfig(env);
    const concurrency = resolveConcurrencyConfig(env);
    const poolConfig = resolveWorkerPoolConfig(env);
    this.scheduler = new ConcurrencyScheduler({ maxConcurrentGenerations: concurrency.maxConcurrentGenerations });
    this.rssBaselineBytes = process.memoryUsage().rss;
    this.telemetry = createMemoryTelemetry({ rssProvider: this.rssFor });
    this.monitor = createPressureMonitor({
      pressureThresholdGb: memoryConfig.pressureThresholdGb,
      pressureSustainedMs: memoryConfig.pressureSustainedMs,
      recoverySustainedMs: memoryConfig.recoverySustainedMs,
    });
    if (poolConfig.rerankerWorkerPoolSize > 1 || poolConfig.embeddingWorkerPoolSize > 1) {
      // Honest-config policy: the parser reports values as configured; the
      // CONSUMPTION site rejects >1 because onnxruntime-node aborts the whole
      // process when one ORT module instance is used from two threads (the
      // B7 single-ORT-owner probe, backend start block below).
      const detail =
        'worker pool sizes > 1 rejected (B7 single-thread ORT ownership: a second ONNX instance on another thread aborts the process); continuing with 1';
      console.error(`[trainingapp-backend] ${detail}`);
      this.config.onMemoryEvent?.({ type: 'telemetry', detail });
    }
    // B9 (issue #67): electron-free dev/CI runs (headless dev-server, the
    // Playwright-under-Electron renderer over vite preview) can widen the
    // guard's CORS allowlist via TRAININGAPP_DESKTOP_DEV_ORIGINS — the same
    // env resolveSecurityConfig() honors on the Electron side. The packaged
    // baseline (app://*) is never dropped; appends only.
    const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS];
    const rawDevOrigins = env[DEV_ORIGINS_ENV];
    if (typeof rawDevOrigins === 'string' && rawDevOrigins.trim().length > 0) {
      for (const part of rawDevOrigins.split(',')) {
        const origin = part.trim();
        if (origin.length > 0) allowedOrigins.push(origin);
      }
    }
    // B9 (issue #67): apply the persisted settings snapshot BEFORE the
    // listener exists, so the first GET /settings already reflects the last
    // accepted override. The sidecar stores ACCEPTED PATCHES (the same key
    // names applySettingsPatch validates) and the host accumulates every
    // accepted PUT into it, so the file round-trips through the boot-time
    // apply exactly; a snapshot from a newer/older schema that the engine
    // rejects simply fails validation and the host boots on defaults.
    // No store path (CI stub runs) => persistence disabled, engine-memory only.
    let persistSettings: ((settings: Record<string, unknown>) => void) | undefined;
    if (this.config.storePath) {
      const storePath = this.config.storePath;
      let storedPatch = loadSettingsSnapshot(storePath) ?? {};
      if (Object.keys(storedPatch).length > 0) {
        const applied = this.engine.applySettingsPatch(storedPatch);
        if (!applied.ok) {
          console.error(
            `[trainingapp-backend] persisted settings snapshot rejected by the engine (${applied.detail}); booting with defaults`,
          );
          storedPatch = {};
        }
      }
      persistSettings = (patch) => {
        storedPatch = { ...storedPatch, ...patch };
        saveSettingsSnapshot(storePath, storedPatch);
      };
    }
    const server = createBackendServer({
      guard: createLoopbackGuard({
        token: this.config.token,
        tokenHeaderName: this.config.tokenHeaderName,
        allowedOrigins: this.config.allowedOrigins ?? allowedOrigins,
      }),
      tokenHeaderName: this.config.tokenHeaderName,
      allowedOrigins: this.config.allowedOrigins ?? allowedOrigins,
      engine: this.engine,
      scheduler: this.scheduler,
      telemetry: () => {
        // The payload's effectiveProfile reflects the ENGINE's actual profile
        // (settings + pressure override) when the engine exposes it — the
        // monitor alone cannot see an explicit inference.profile setting.
        // downgraded remains the pressure-latch state (S6/AC3).
        const status = this.monitor?.evaluate() ?? { downgraded: false };
        const engineProfile = (this.engine as { effectiveProfile?: () => 'quality' | 'fast' })
          .effectiveProfile?.();
        return {
          snapshot: this.telemetry?.snapshot() ?? {},
          downgrade: {
            effectiveProfile: engineProfile ?? 'quality',
            downgraded: status.downgraded,
          },
        };
      },
      modelStatus: typeof this.engine.modelStatus === 'function'
        ? () => this.engine.modelStatus!()
        : undefined,
      persistSettings,
    });
    try {
      const port = await listenOnRandomPort(server);
      this.server = server;
      this.handle = { mode: this.mode, port, url: `http://127.0.0.1:${port}` };
      // B6 store (issue #64): the store is now load-bearing for ingestion.
      // Corruption is recovered BEFORE serving (integrity check + restore/
      // fresh policy via config.onStoreCorruption; auto restore-else-fresh
      // when no prompt seam is wired — the headless/CI case). Any OTHER open
      // failure keeps the B5 degradation: log-and-continue without a store.
      if (this.config.storePath) {
        try {
          this.store = openStore({
            dbPath: this.config.storePath,
            dims: this.config.storeEmbeddingDims,
          });
        } catch (err) {
          this.store = await recoverOrDegradeStore(this.config, err);
        }
        if (this.store !== null) {
          const env = this.config.env ?? process.env;
          // Resolve the embedder FIRST (null when unavailable: weights not
          // staged, bad env) so the B7 wiring below can reuse it. Mirrors the
          // B5/B6 degrade contract: a missing model degrades the store surface
          // to embedder-less operation, it never fails host start (CI has no
          // staged weights; the LFS pointer must not take the host down).
          try {
            this.embedder = resolveEmbedder({
              env,
              dims: this.store.dims,
              repoRoot: process.env.TRAININGAPP_DESKTOP_REPO_ROOT,
            });
          } catch (err) {
            console.error(
              `[trainingapp-backend] embedding model unavailable (store surface degrades to embedder-less): ${err instanceof Error ? err.message : String(err)}`,
            );
            this.embedder = null;
          }
          // B7 (issue #65), SINGLE-THREAD ORT OWNERSHIP: onnxruntime-node
          // aborts the whole process when one module instance is used from
          // two threads of one process (empirically probed 2026-09-09; trace
          // repro/mix-probe.mjs). When real ONNX weights are staged AND
          // reranking is enabled, the retrieval worker is created FIRST and
          // owns ALL onnxruntime work — ingest and query embeddings are
          // proxied to it (WorkerEmbedder) so the main thread never loads
          // ort. The hash fixture (no ORT) stays on the main thread; with
          // rerank disabled there is no worker and the main thread keeps its
          // sole-threaded ORT use.
          const retrievalConfig = resolveRetrievalConfig(env);
          try {
            const rerankerModelDir = resolveRerankerModelDir({
              env,
              repoRoot: process.env.TRAININGAPP_DESKTOP_REPO_ROOT,
            });
            if (
              this.embedder instanceof OnnxEmbedder &&
              retrievalConfig.rerank &&
              rerankerModelDir !== null
            ) {
              // B8 (issue #66): the worker is RESUMABLE — the idle-unload
              // controller may terminate it after memory.idleUnloadMs idle;
              // the next score/embed transparently rebuilds it (reload
              // latency recorded for AC5). onUse re-arms the idle window on
              // every job start (score/embed/ingest embeds alike).
              const resumable = new ResumableReranker({
                modelDir: rerankerModelDir,
                embedModelDir: this.embedder.weightsDir,
                onUse: () => {
                  this.idle?.touch();
                },
                onReload: (ms) => {
                  this.idle?.recordReload(ms);
                },
              });
              this.idle = new IdleUnloadController({
                idleUnloadMs: memoryConfig.idleUnloadMs,
                unload: () => resumable.unload(),
              });
              this.resumable = resumable;
              this.reranker = resumable;
              this.embedder = new WorkerEmbedder(resumable, this.embedder.modelId);
              this.embedsViaWorker = true;
            }
          } catch (err) {
            // Reranker unavailable: degrade to fused-ordering retrieval with
            // the embedder as-is (no worker exists, so main-thread ORT stays
            // single-threaded). Never fail host start. B8: the resumable
            // wrapper and its idle controller are torn down with it.
            this.reranker = null;
            this.resumable = null;
            this.idle?.dispose();
            this.idle = null;
            this.embedsViaWorker = false;
            console.error(
              `[trainingapp-backend] reranker unavailable (retrieval degrades to fused ordering): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          attachStoreSurface(this.config, this.engine, this.store, this.embedder, {
            get: () => this.store,
            set: (handle: StoreHandle | null) => {
              this.store = handle;
            },
          }, this.scheduler);
          if (this.embedder !== null) {
            // B7: attach the hybrid retrieval surface AFTER the document
            // surface, reusing the same (possibly worker-proxied) embedder.
            this.retrieval = createRetrievalSurface({
              store: this.store,
              embedder: this.embedder,
              reranker: this.reranker,
              config: retrievalConfig,
            });
            if (typeof this.engine.attachRetrievalSurface === 'function') {
              this.engine.attachRetrievalSurface(this.retrieval);
            }
          }
        }
      }
      // B8 (issue #66): the sampler loop — observe/evaluate/downgrade at
      // memory.telemetryIntervalMs. unref'd so a headless host can still exit.
      // The tick's rejection is consumed here (log + keep the sampler alive):
      // an unhandled rejection from a raced worker disposal must not take the
      // host down in plain-node entries (PRR-F2).
      this.telemetryTimer = setInterval(() => {
        void this.memoryTick().catch((err: unknown) => {
          console.error(
            `[trainingapp-backend] memory tick failed (sampler continues): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, memoryConfig.telemetryIntervalMs);
      this.telemetryTimer.unref?.();
      return this.handle;
    } catch (err) {
      // Partial-init cleanup: a failed bind must not leak the listener into
      // the next start() retry.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw err;
    }
  }



  async stop(): Promise<void> {
    const dbg = (m: string): void => {
      if (process.env.TRAININGAPP_CORS_DEBUG) console.error(`[stop-debug] ${m}`);
    };
    dbg('begin');
    // B8 (issue #66) governance teardown FIRST: no sampler fires mid-shutdown,
    // the idle controller never fires after dispose, and queued (not yet
    // started) generations fail fast instead of running after close.
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.idle?.dispose();
    this.idle = null;
    this.scheduler?.rejectQueued(new Error('backend host is stopping'));
    this.scheduler = null;
    this.telemetry = null;
    this.monitor = null;
    this.workerMemory = null;
    this.embedsViaWorker = false;
    this.downgradeLatched = false;
    this.recoveryEmitted = false;
    this.resumable = null;
    const server = this.server;
    this.server = null;
    this.handle = null;
    if (this.surface !== null && typeof this.engine.attachDocumentSurface === 'function') {
      this.engine.attachDocumentSurface(null);
      this.surface = null;
    }
    if (this.retrieval !== null && typeof this.engine.attachRetrievalSurface === 'function') {
      this.engine.attachRetrievalSurface(null);
      this.retrieval = null;
    }
    const reranker = this.reranker;
    this.reranker = null;
    const store = this.store;
    this.store = null;
    try {
      if (reranker !== null && typeof (reranker as WorkerReranker).dispose === 'function') {
        await (reranker as WorkerReranker).dispose();
      }
    } finally {
      try {
        if (store !== null) closeStore(store);
      } finally {
        // The listener must close even if the store close throws. The
        // renderer holds keep-alive sockets that would keep server.close()
        // pending forever (issue #67 e2e: app quit hung on them) — drop
        // idle/remaining connections explicitly before awaiting close.
        if (server !== null) {
          if (typeof (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections === 'function') {
            (server as unknown as { closeIdleConnections: () => void }).closeIdleConnections();
          }
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          dbg('connections dropped; awaiting server close');
          await new Promise<void>((resolve) => server.close(() => resolve()));
          dbg('server closed');
        }
      }
    }
  }


}

/** Sidecar-mode host: guarded listener + proxy fronting the spawned child. */
export class SidecarBackendHost implements BackendHost {
  readonly mode: BackendMode = 'sidecar';
  private server: ReturnType<typeof createBackendServer> | null = null;
  private manager: SidecarManager | null = null;
  private handle: BackendHandle | null = null;

  constructor(private readonly config: BackendHostConfig) {}

  async start(): Promise<BackendHandle> {
    if (this.handle) return this.handle;
    const sidecar = this.config.sidecar ?? {};
    const command = sidecar.command;
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('backend.mode "sidecar" requires sidecar.command (the backend executable to spawn)');
    }
    // Reserve the loopback port the child will bind, then front it.
    const upstreamPort = sidecar.port ?? (await reserveFreePort());
    const args = sidecar.args ?? [];
    const manager = new SidecarManager({
      command,
      args,
      cwd: sidecar.cwd,
      env: sidecar.env,
      port: upstreamPort,
      maxWaitMs: sidecar.healthTimeoutMs ?? 60000,
    });
    manager.on('restart', (attempt, delayMs) => {
      console.error(`[trainingapp-backend] sidecar exited; restarting (attempt ${attempt} after ${delayMs}ms backoff)`);
    });
    manager.on('gave-up', (attempts) => {
      console.error(`[trainingapp-backend] sidecar restart bound exceeded after ${attempts} restarts; giving up`);
      this.config.onGiveUp?.(attempts);
    });
    await manager.start();
    const server = createBackendServer({
      guard: createLoopbackGuard({
        token: this.config.token,
        tokenHeaderName: this.config.tokenHeaderName,
        allowedOrigins: this.config.allowedOrigins,
      }),
      tokenHeaderName: this.config.tokenHeaderName,
      allowedOrigins: this.config.allowedOrigins,
      upstreamPort,
    });
    try {
      const port = await listenOnRandomPort(server);
      this.manager = manager;
      this.server = server;
      this.handle = { mode: this.mode, port, url: `http://127.0.0.1:${port}` };
      return this.handle;
    } catch (err) {
      // Partial-init cleanup: a failed listener bind must leave NEITHER a
      // leaked server NOR an orphaned, untracked sidecar child.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const manager = this.manager;
    this.server = null;
    this.manager = null;
    this.handle = null;
    if (manager !== null) await manager.stop();
    if (server !== null) {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}


/**
 * Recovery-first store-open failure handling (B6): when the file is corrupt,
 * run the recovery policy (interactive prompt or auto) and reopen; the host
 * only degrades (null store) when recovery is impossible or the failure is
 * not corruption (e.g. a dims mismatch — the b5 test pins log-and-continue).
 * Module-level BY DESIGN: the b3 duck-type pin requires both host prototypes
 * to expose exactly start/stop, so node-only helpers stay off the prototype.
 */
async function recoverOrDegradeStore(
  config: BackendHostConfig,
  openError: unknown,
): Promise<StoreHandle | null> {
  const dbPath = config.storePath as string;
  // Degradation (not recovery) applies when the file was never created or the
  // failure is not integrity corruption (dims mismatch, locked file...).
  if (!fs.existsSync(dbPath) || checkStoreIntegrity(dbPath).ok) {
    console.error(
      `[trainingapp-backend] store init failed (continuing without store): ${openError instanceof Error ? openError.message : String(openError)}`,
    );
    return null;
  }
  try {
    const backupsDir = config.storeBackupsDir ?? path.join(path.dirname(dbPath), 'backups');
    const outcome = await recoverStore({
      dbPath,
      backupsDir,
      dims: config.storeEmbeddingDims ?? 0,
      choose: config.onStoreCorruption
        ? (info) => config.onStoreCorruption?.(info) ?? Promise.resolve('fresh')
        : undefined,
    });
    console.error(
      `[trainingapp-backend] store recovered (action=${outcome.action}${outcome.restoredFrom ? ` from ${outcome.restoredFrom}` : ''})`,
    );
    return openStore({ dbPath, dims: config.storeEmbeddingDims });
  } catch (recoverErr) {
    console.error(
      `[trainingapp-backend] store init failed (continuing without store): recovery could not restore the corrupt store: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`,
    );
    return null;
  }
}

interface StoreAccessors {
  get: () => StoreHandle | null;
  set: (handle: StoreHandle | null) => void;
}

/** Build the B6 document surface (embedder + pipeline) and hand it to the engine.
 *  The embedder is resolved (and possibly worker-proxied) by the caller so the
 *  document and retrieval surfaces share ONE embedding source. */
function attachStoreSurface(
  config: BackendHostConfig,
  engine: EngineSurface,
  store: StoreHandle,
  embedder: EmbeddingSurface | null,
  accessors: StoreAccessors,
  coordination: ConcurrencyScheduler | null,
): void {
  if (embedder === null) {
    // No usable embedder (weights not staged, bad env): the document surface
    // stays detached and the engine keeps its stub document behavior; the
    // rest of the host serves.
    console.error('[trainingapp-backend] ingest surface unavailable (documents stay stubbed): no embedding model staged');
    return;
  }
  const env = config.env ?? process.env;
  const surface = new StoreDocumentSurface({
    getStore: accessors.get,
    setStore: accessors.set,
    embedder,
    config: resolveIngestConfig(env),
    limits: resolveIngestLimits(env),
    onProgress: config.onIngestProgress,
    // B8 (issue #66, S3): the embed phase pauses while a generation runs.
    ...(coordination !== null ? { coordination } : {}),
  });
  if (typeof (engine as { attachDocumentSurface?: unknown }).attachDocumentSurface === 'function') {
    engine.attachDocumentSurface?.(surface);
  }
}

/** Resolve the config and build the ONE host interface for B4-B9. */
export function createBackendHost(config: BackendHostConfig): BackendHost {
  const mode = resolveBackendMode({ mode: config.mode, env: config.env });
  if (mode === 'sidecar') return new SidecarBackendHost(config);
  return new NodeBackendHost(config);
}
