## 🧪 swarm-pr-review — PR #43 (Issue #37 PR-2)

**Verdict: NEEDS_REVISION** — 1 CRITICAL, 2 HIGH, multiple PRE-EXISTING claims.

Review: 6 parallel explorer lanes → 1 independent reviewer. Deterministic signals: typecheck PASS ✅, CI PASS ✅, eval harness 3/3 PASS ✅.

---

### 🛑 CRITICAL — P2: Air-gap tree-shaking NOT implemented

**File:** `web_ui/src/lib/llm/web-llm-service.ts:186`

The PR body claims `VITE_AIRGAP=1` gates the `@mlc-ai/web-llm` dynamic import so Rollup tree-shakes it. **This is false.** `airgap.ts:10-18` defines `IS_AIRGAP` but it's **never used** to guard the import at line 186:

```ts
const mod = await import('@mlc-ai/web-llm');  // ← no IS_AIRGAP guard
```

The WebLLM chunk WILL be included in air-gap builds, defeating the core air-gap hardening claim.

### ⚠️ HIGH — P2: `validate-build --airgap` silently ignored

**Files:** `web_ui/scripts/build-airgap.mjs:57-60` passes `--airgap` to validate-build, but `web_ui/scripts/validate-build.mjs:54-60` only processes `--no-llm` and `--no-reranker`. The advertised air-gap symbol check never runs.

### ⚠️ HIGH — P3: IsolationBanner NOT mounted in ChatPage

**Files:** `web_ui/src/components/IsolationBanner.tsx:48-85` is implemented, but `ChatPage.tsx` has zero references or imports of `IsolationBanner`. The component exists but is never rendered.

### 📝 PRE-EXISTING: PR body claims changes not found in this diff

The following work items are **claimed in the PR body** but the files are unchanged from the base branch. These changes may exist on the branch (landed via PR-1 or earlier commits) but are **not part of this PR's diff**:

| Claim | Current state | File |
|-------|--------------|------|
| R4: `tokenize:full→forward`, stopwords | `tokenize: 'full'`, no stopwords | `keyword-index.ts:102` |
| R5: overlap `100→32`, PDF/XLSX/empty-chunk/dedup | default overlap `100` | `text-chunker.ts:41` |
| R6: history turns, contextualized query | no history param | `rag-orchestrator.ts:195` |
| R7: `CHARS_PER_TOKEN 4→3.7`, template overhead, image estimate | `CHARS_PER_TOKEN = 4` | `rag-orchestrator.ts:159` |
| R8: `VECTOR_INDEX_VERSION 2→3` | `VECTOR_INDEX_VERSION = 2` | `vector-index.ts:32` |
| R8: dead-code deletion (`browser-compat.ts`, `selectModelTier`) | files exist | `browser-compat.ts`, `memory-aware.ts` |
| P1: CI smoke wired to web-ui.yml | no workflow changes in diff | — |
| P5: Clear Cache updates | not in 11-file diff | — |

The 11-file diff contains **only** new additions; none of the existing modified files (keyword-index.ts, text-chunker.ts, rag-orchestrator.ts, vector-index.ts, etc.) are included. This means either:
1. These changes were intended to be in PR-1 (#42) but weren't committed, OR
2. These files will land in a separate commit, OR
3. The PR body overstates the scope.

### ✅ Verified Sound

| Check | Result |
|-------|--------|
| **embedding.worker.ts** | Clean — `configureOfflineEnv()` called before transformers.js, message protocol correct, batch validation present. No orphaned `});` (lane 6 hallucination) |
| **eval-harness.test.ts** | 3/3 PASS — recall@k, abstention, RRF k=60 invariant all verified |
| **eval corpus (eval.jsonl)** | 10 in-corpus, 3 OOC questions — lightweight but functional |
| **Typecheck** | PASS (both tsconfigs) |
| **CI** | PASS |
| **Security** | No new injection, path traversal, or credential exposure vectors |
| **api_server.py** | History parameter added to QuestionRequest, backward compatible |
| **duplicate-guard.ts** | Clean `isDuplicate` with re-index bypass (`chunkCount === 0`) |
| **smoke-coop-coep.mjs** | Correct COOP/COEP headers, path-safe serving |

### Required Fixes

1. **🛑 CRITICAL**: Add `IS_AIRGAP` guard around `await import('@mlc-ai/web-llm')` in `web-llm-service.ts:186`.
2. **⚠️ HIGH**: Add `--airgap` processing to `validate-build.mjs`, or remove the flag passage from `build-airgap.mjs`.
3. **⚠️ HIGH**: Mount `IsolationBanner` in `ChatPage.tsx`.
4. **📝 PRE-EXISTING**: Either implement the claimed R4/R5/R6/R7/R8/P1/P5 changes in actual modified files, or correct the PR description to match the 11-file addition scope.
