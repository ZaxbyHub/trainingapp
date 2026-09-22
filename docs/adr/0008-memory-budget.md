# ADR-0008: Runtime memory budget, concurrency governance, and idle-session unloading

- **Status:** Accepted (implementation in progress on issue #66, B8)
- **Date:** 2026-09-10
- **Deciders:** Workstream B (desktop backend), issue #66
- **Supersedes:** none · **Related:** ADR-0005 (store), ADR-0006 (profile model), ADR-0007 (relevance floor)

## Context

The v3 hardware floor is a 12th-gen i5 with 16 GB RAM (`.swarm/spec-snapshot.md`). Before this ADR,
no measured, enforced peak-RAM budget existed for the whole running system (Chromium + resident LLM
weights/KV + embedding/reranker ONNX sessions + worker pools + SQLite). Each component carried its
own siloed story: B4 picked Quality/Fast per query from a single `os.freemem()` reading, B7's
retrieval worker lived until app exit, and B6 ingestion ran regardless of in-flight generations.
The browser surface's `navigator.deviceMemory` heuristics are memory-blind by construction (they
report total device RAM capped at 8 GB, never free RAM) and are explicitly NOT imported here —
Electron has `os.freemem()`/`os.totalmem()`.

## Decision

### 1. Budget and telemetry (`desktop/main/backend/memory/`)

- `memory.maxTotalGb` defaults to **16** (`TRAININGAPP_MEMORY_MAX_TOTAL_GB`); it is the accounting
  ceiling the component table (below) must sum under with headroom.
- `memory.pressureThresholdGb` defaults to **6** — the SAME constant as B4's
  `inference.profileThresholdGb` (`DEFAULT_PROFILE_THRESHOLD_GB`, imported, not restated; pinned by
  b8-wiring C9 so the two knobs cannot drift).
- `memory.telemetryIntervalMs` (5000) drives the host sampler;
  `memory.pressureSustainedMs` (10000), `memory.recoverySustainedMs` (60000) and
  `memory.idleUnloadMs` (300000) are the hysteresis/idle windows. All are env-overridable with
  strict positive-integer parsing (junk/zero fall back to defaults).
- `GET /telemetry/memory` returns `{ snapshot: MemorySnapshot, downgrade: DowngradeState }`
  (`contracts/api.openapi.yaml` v2.4.0). It is transport-token-guarded like every route (it reveals
  process memory; never `/health`-style unauthenticated). A host without a telemetry provider
  answers a contract-safe 503 — the path is known, never 404-absent.

### 2. Component attribution semantics (in-process Node backend; ADR-0003 still open)

| Component | Source | Semantics |
|---|---|---|
| `chromiumRssMb` | `process.memoryUsage().rss` (main) | Whole main-process RSS, INCLUDING the native heaps (llama.cpp mmap, main-thread ORT when the hash fixture is used, better-sqlite3). |
| `llmRssMb` | baseline-relative delta | Main-RSS now minus main-RSS at host start; dominated by the resident llama model once loaded. It is a delta of ALL post-start growth (not gated on model residency — treat it as an increment subsumed in `chromiumRssMb`, never a separate budget line), and reads 0 before any post-start growth. |
| `embeddingSessionRssMb` / `rerankerSessionRssMb` | worker `process.memoryUsage()` (`external`+`arrayBuffers`) | Thread-local ONNX footprint from the single retrieval worker (B7 owns ALL ORT work on one thread). 0 while the worker is unloaded/absent. |
| `sqliteRssMb` | better-sqlite3 `memoryUsed()` | The driver's own heap counter. 0 when no store is open. |

These are honest-but-approximate per-component attributions inside one process; the measured-sum
evidence (AC6) therefore comes from the soak harness's process-level samples plus the reference
bench rows, not from summing the snapshot fields alone.

### 3. Concurrency governance (`memory/scheduler.ts`)

- `concurrency.maxConcurrentGenerations` defaults to **1**: `/ask` and `/ask/stream` execute under
  a FIFO mutex in the transport (`server.ts`), engine-independent (it holds for the CI StubEngine
  too, which B4's per-engine private queue never covered). Excess generations queue; they never
  503.
- The `/ask/stream` preflight runs OUTSIDE the mutex — a missing-model 503 must never queue behind
  an in-flight generation.
- Ingestion pause: the B6 embed phase awaits `scheduler.waitForGenerationEnd()` before every embed
  call (`IngestPipelineOptions.coordination`). Extract/chunk/write phases are unaffected; only
  embed-heavy work yields to generation.

### 4. Worker pools (S4)

`embedding.workerPoolSize` and `reranker.workerPoolSize` are explicit configuration
(`TRAININGAPP_{EMBEDDING,RERANKER}_WORKER_POOL_SIZE`, default **1**, never `os.cpus()`-derived).
The parser is honest (it reports 3 if you configure 3); the CONSUMPTION site rejects >1: B7's
empirical probe (backend start block; trace repro/mix-probe.mjs) showed onnxruntime-node aborts the
whole process when one module instance is used from two threads, so a >1 reranker pool would need
per-worker ORT isolation AND duplicated model memory — rejected until a future issue proves it.

### 5. Downgrade and recovery (AC2/AC3 — the documented decision)

- **Downgrade:** when free RAM stays strictly below `pressureThresholdGb` for
  `pressureSustainedMs`, the host latches `engine.setProfileOverride('fast')` (the user's
  `inference.profile` setting is NEVER mutated), logs the observed free-RAM value, and emits
  `memory:event {type:'downgrade'}` to the renderer.
- **Recovery / no silent auto-upgrade:** after the downgrade, sustained above-threshold free RAM
  for `recoverySustainedMs` latches `recoveryEligible` (event `recovery-eligible` fires once). The
  override clears ONLY at a sampler tick where the scheduler is fully drained
  (`generationInFlight === false && queueDepth === 0 && activeGenerations === 0`). At that upgrade
  the host ACKNOWLEDGES the monitor (`resetAfterUpgrade()`), which clears the monitor's downgrade
  latch so the next downgrade requires a NEW sustained pressure episode — without the ack, the
  never-reset latch re-latched 'fast' on the next tick (fast/quality oscillation + event spam;
  PR-review finding PRR-F1, pinned by b8-host-loop.test.ts). Bounded
  staleness: at most one telemetry interval past predicate satisfaction. Rationale: flipping the
  resident model mid-session under oscillating pressure thrashes the resident sequence and KV
  cache; a drained-transition makes the flip atomic with respect to generation work.
- Monitor hysteresis is a pure state machine (no timer inside the monitor); a return to pressure
  revokes eligibility.

### 6. Idle-session unloading (AC5)

- `memory.idleUnloadMs` (300000): the retrieval worker (the single ONNX owner) is terminated after
  the idle window with no rerank/embed/ingest-embed use; the NEXT request transparently rebuilds
  it, and the measured construct-to-first-answer reload latency is recorded
  (`IdleUnloadController.recordReload`) and reported via `onReload`.
- The resident LLM is deliberately NOT unloaded on idle: B4's resident-model contract (load once,
  reuse across requests) is the latency story of the product; S5 scopes idle-unload to the
  embedding/reranker ONNX sessions.

## Measured component budget (devstation, provisional)

Measured 2026-09-11 via `desktop/test/soak/memory-soak.mjs` on the devstation (not the reference
laptop — see `bench/RESULTS.md` "Desktop runtime memory (B8)"): values and the sum-vs-ceiling
statement live there. Reference-laptop rows are **PENDING** the physical soak (AC1 waiver decision
recorded in the issue-trace/PR); re-run and update this table if B4/B7 change their footprint.

## Consequences

- The renderer (B9) gains `memory:event` and `GET /telemetry/memory` for a live memory UI.
- First-run validation (#85) and the low-RAM matrix (#86) consume the same thresholds.
- A sidecar-mode host forwards `/telemetry/memory` to the child transparently; if ADR-0003 ever
  selects a Python sidecar, its PID's RSS joins the snapshot through the documented provider seam.
- Rollback: revert the PR; no schema or data migration.
