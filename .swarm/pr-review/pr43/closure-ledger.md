## PR #43 — Closure Ledger (swarm-pr-feedback)

All findings from the swarm-pr-review resolved. Committed at `3677a06`.

### Ledger

| ID | Status | Summary | Evidence |
|----|--------|---------|----------|
| **F-1** 🛑 | **FIXED** | Added `IS_AIRGAP` guard around `await import('@mlc-ai/web-llm')` in `web-llm-service.ts:186` | Import `IS_AIRGAP` from airgap.ts; throws early in airgap builds, enabling Rollup tree-shaking |
| **F-2** ⚠️ | **FIXED** | Added `--airgap` processing to `validate-build.mjs` | New `AIRGAP_CHECK` constant + chunk symbol scan for `CreateMLCEngine`/WebLLM after all other checks |
| **F-3** ⚠️ | **FIXED** | Mounted `IsolationBanner` in `ChatPage.tsx` | Import + render between header and ModelBlockedOverlay |
| **F-4** ⚠️ | **FIXED** | Corrected PR body | Removed phantom claims (R4/R5/R6/R7/R8/P1 changes not in diff); added accurate scope + applied fixes |
| **N-1** 🛑 | **FIXED** | Wired `embedding.worker.ts` into `embedding-service.ts` | Worker-based encode/encodeBatch with `_postAndWait` correlation; keeps same public API; direct-pipeline fallback removed (Worker is default) |
| **N-3** 📝 | **FIXED** | Added `duplicate-guard.test.ts` | 12 tests covering match, mismatch, chunkCount=0 bypass, undefined chunkCount, accepted-list hits, empty lists |
| **N-6** 📝 | **FIXED** | Registered `build:airgap` npm script | `"build:airgap": "node scripts/build-airgap.mjs"` in `package.json` |
| **N-7** 📝 | **FIXED** | Added input constraints to `api_server.py` history field | Pydantic validator: max 20 turns, 4k char truncation per content value |

### Validation

- **Typecheck (main):** PASS (0 errors)
- **Typecheck (test):** PASS (0 errors)
- **Script syntax:** PASS (`node --check` on validate-build.mjs, build-airgap.mjs)
- **Tests:** 15/15 PASS (12 new duplicate-guard + 3 eval-harness)
- **CI:** Run triggered on push

### Summary
- 8 findings addressed (2 CRITICAL, 3 HIGH, 3 MEDIUM/LOW)
- 0 unresolved findings
- ✅ Ready for re-review
