## 🧪 swarm-pr-review — PR #43 (Issue #37 PR-2)

**Verdict: NEEDS_REVISION** — 2 CRITICAL, 3 HIGH findings.

Review: 6 parallel explorer lanes (branch verified checked out) → 1 independent reviewer. Deterministic: typecheck PASS ✅, CI PASS ✅, eval harness 3/3 PASS ✅.

---

### 🛑 CRITICAL — F-1: Air-gap tree-shaking NOT implemented

**File:** `web_ui/src/lib/llm/web-llm-service.ts:186`

`IS_AIRGAP` is defined at `airgap.ts:22` but **never used**. The dynamic import at line 186:
```ts
const mod = await import('@mlc-ai/web-llm');  // ← unconditional, no IS_AIRGAP guard
```
is unconditional. Rollup cannot tree-shake `@mlc-ai/web-llm`. The core air-gap hardening claim is false.

### 🛑 CRITICAL — N-1: embedding.worker.ts is dead code

**File:** `web_ui/src/lib/embeddings/embedding.worker.ts` (162 lines)

The Web Worker is **never referenced** by any existing code. `embedding-service.ts:13-348` continues to create the `feature-extraction` pipeline on the **main thread** with no Worker instantiation. No `new Worker(new URL(...))` exists anywhere in the diff or the codebase. Additionally:

- **Zero test coverage** — Workers cannot be instantiated in Vitest with jsdom (no Worker polyfill in `vitest.config.ts` or `src/test/setup.ts`)
- **No dispose/terminate path** — `FeatureExtractionPipeline` has an optional `dispose()` method but the protocol has no disposal message handler; pipeline persists for the worker's full lifetime

The advertised "bulk ingestion no longer janks the UI" benefit does not exist at runtime.

### ⚠️ HIGH — F-2: `validate-build --airgap` silently ignored

**Files:** `build-airgap.mjs:60` passes `--airgap` but `validate-build.mjs:54-60` only processes `--no-llm` and `--no-reranker`. The advertised air-gap symbol check never runs.

### ⚠️ HIGH — F-3: IsolationBanner NOT mounted in ChatPage

**Files:** `IsolationBanner.tsx:48-85` exists but `ChatPage.tsx` has zero imports or references. The component is never rendered.

### ⚠️ HIGH — F-4: Multiple PR body claims not reflected in diff

The following files were **NOT changed** in this PR despite being claimed in the PR body:

| Claim | Current State | File:Line |
|-------|--------------|-----------|
| R4: `tokenize:full→forward`, stopwords | `tokenize: 'full'`, no stopwords | `keyword-index.ts:102` |
| R5: overlap `100→32`, PDF/XLSX/dedup | overlap `100` | `text-chunker.ts:45` |
| R6: history turns, contextualized query | No history param | `rag-orchestrator.ts:159` |
| R7: `CHARS_PER_TOKEN 4→3.7`, template/img constants | `CHARS_PER_TOKEN = 4` | `rag-orchestrator.ts:159` |
| R8: `VECTOR_INDEX_VERSION 2→3` | `VECTOR_INDEX_VERSION = 2` | `vector-index.ts:32` |
| R8: dead-code deletion (`browser-compat.ts`, `selectModelTier`) | Files exist | `browser-compat.ts`, `memory-aware.ts` |
| P1: CI smoke wired to `web-ui.yml` | No workflow changes in diff | `.github/workflows/web-ui.yml` |
| R8: thread cap 4→6 | Not in diff | `memory-aware.ts` |

### 📝 MEDIUM — Additional findings

| ID | Severity | Finding | File |
|----|----------|---------|------|
| N-3 | MED | `duplicate-guard.ts` has zero test coverage | `duplicate-guard.ts` |
| N-6 | MED | `npm run build:airgap` is not registered in `package.json` | `package.json` |
| N-7 | LOW | `api_server.py` `history` field has no max-list-length or max-string-length constraints | `api_server.py:186` |

### ✅ Verified Sound

| Check | Result |
|-------|--------|
| **embedding.worker.ts** | `configureOfflineEnv()` called before transformers.js ✓, message protocol sound ✓, batch validation present ✓. Design is clean — just not wired |
| **eval-harness.test.ts** | 3/3 PASS — recall@k, abstention, RRF k=60 ✓ |
| **duplicate-guard.ts** | Clean `isDuplicate` with re-index bypass ✓ |
| **smoke-coop-coep.mjs** | Correct COOP/COEP headers ✓, path-safe serving ✓ |
| **build-airgap.mjs** | Sequentially correct (prepare-models → build → validate) ✓ |
| **api_server.py** | Backward-compatible history addition ✓ |
| **Security** | No new injection/path traversal vectors in code that actually runs |
| **Typecheck** | PASS (both tsconfigs) |
| **CI** | PASS |

### Required Fixes

1. **🛑 CRITICAL**: Add `IS_AIRGAP` guard around `await import('@mlc-ai/web-llm')` in `web-llm-service.ts:186` or wire the guard in the engine factory.
2. **🛑 CRITICAL**: Either wire `embedding.worker.ts` into `embedding-service.ts` via `new Worker(new URL(...))`, or remove the dead code and correct the PR description. Add a Worker polyfill to `vitest.config.ts` if keeping the worker.
3. **⚠️ HIGH**: Add `--airgap` processing to `validate-build.mjs` or remove the flag passage from `build-airgap.mjs`.
4. **⚠️ HIGH**: Mount `IsolationBanner` in `ChatPage.tsx`.
5. **⚠️ HIGH**: Either implement the claimed R4/R5/R6/R7/R8/P1 changes in actual modified files, or correct the PR description to match the 11-file addition scope.
