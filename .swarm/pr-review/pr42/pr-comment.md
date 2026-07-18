## 🧪 swarm-pr-review — PR #42

**Verdict: APPROVED** — 2 LOW findings (advisory, non-blocking).

Review: 6 parallel explorer lanes → 1 independent reviewer → 1 critic challenge. Deterministic signals: typecheck PASS ✅, CI latest run PASS ✅, 50/77 test files failing (ALL pre-existing, same count without PR changes).

---

### 📝 LOW — Advisory findings (not blocking)

**F-1: Malformed checksum sidecar silently ignored**
`web_ui/scripts/validate-build.mjs:121-131`

The try/catch around `JSON.parse` for the `manifest.checksums.json` sidecar silently falls through when the file is malformed. If both candidate sidecars fail parsing, `checksums` stays `{}`, lines 165-168 produce no `checksumJobs`, and lines 173-188 skip all SHA-256 verification. The packaging integrity guarantee becomes a no-op without warning.

**F-2: RERANK_INPUT_CAP test doesn't prove the cap**
`web_ui/src/lib/search/reranker.test.ts:476-510`

The test feeds 60 inputs with `RERANKER_BATCH_SIZE=12`. Without the 50-item cap: 60 pairs → ceil(60/12) = 5 batches. With the cap: 50 pairs → ceil(50/12) = 5 batches. The assertion `expect(pairsScored).toBe(5)` matches both scenarios and does not prove the 50-item cap is actually enforced.

---

### ✅ Verified Sound

| Category | Result |
|----------|--------|
| **R1a (boot init)** | `useServiceInitialization.ts:158` calls `getRerankerService().initialize()` fire-and-forget after vector+keyword init |
| **R1b (correct scoring)** | `reranker.ts:203-204` uses `AutoTokenizer.from_pretrained` + `AutoModelForSequenceClassification.from_pretrained` directly, `text_pair` at line 312, `sigmoid` at line 319 |
| **R1c (packaged weights)** | `manifest.json:27-37` flips reranker group to `"core"`, all files `required: true`; `prepare-models.mjs` now `fail()`s on missing reranker |
| **R2 (over-fetch)** | `rag-presets.ts:19,21,24` — fast:1, balanced:3, quality:4; `rag-orchestrator.ts:200-201` computes `fetchK = topK * candidateMultiplier` |
| **R2 (ef_search 128)** | `vector-index.ts:121` — `config.ef_search = 128`; dead `efSearch` field deleted from `types/search.ts` |
| **R3 (abstention floor)** | `rag-orchestrator.ts:132` — `MIN_CROSS_SCORE = 0.2`; line 150 — `DEGRADED_VECTOR_COSINE_FLOOR = 0.4`; applied pre-fusion at line 324 |
| **P4 (packaging integrity)** | SHA-256 streaming (`createReadStream` + `for await`), LFS pointer detection, Vite chunk check — all in `validate-build.mjs` |
| **P6 (missing-model UX)** | `model-readiness.ts` — wllama missing GGUF is a readiness FAILURE, admin-oriented message path verified |
| **CI --no-reranker** | `web-ui.yml:71,86,104` passes `--no-reranker`; `prepare-models.mjs:38-45` handles the flag; writes `VITE_EXCLUDE_MODEL_GROUPS=reranker` |
| **All 6 invariants** | BGE query prefix, L2-normalize + cosine, CLS pooling, RRF k=60, zero-chunk abstention, boot ordering — all confirmed untouched |
| **Security** | CLEAN — all paths from hardcoded constants; `configureOfflineEnv()` prevents remote fetches; no secrets, credentials, or injection vectors |
| **Failed init retry** | `reranker.ts:226` clears `initPromise` before rejecting, so subsequent `initialize()` calls properly retry |
| **didRerank flag** | Set only AFTER awaited `rerank()` succeeds (`rag-orchestrator.ts:364-381`) — no race condition |
| **Empty-text alignment** | Empty-text items excluded before tokenizer batching (`reranker.ts:287-296`), arrays stay aligned |
| **Tokenizer leak** | Transformers.js tokenizer is JS object construction with no disposal API; ONNX session owned by model, disposed correctly at `reranker.ts:217-223` |
| **Test coverage** | `reranker.test.ts` verifies `AutoTokenizer`/`AutoModel` factories; `rag-orchestrator.test.ts` verifies cosine floor pre-fusion |

### Disproved Candidates
- Lane 4 (docs-intent) candidates C-001 through C-011 — all DISPROVED. The explorer hallucinated missing implementations. ALL PR features verified present on disk.

### Suggested Fixes (non-blocking)
1. **F-1**: Treat a malformed checksum sidecar as a build failure (or require a successfully parsed alternative path).
2. **F-2**: Add a cap test that records total tokenizer passages and asserts exactly 50.

### Phase 0B — Branch State
- `mergeStateStatus: BLOCKED` (likely branch protection / check requirements — not a conflict)
- `mergeable: MERGEABLE` — no merge conflicts
- No review comments or reviews on this PR
- CI latest run: PASS
- Handoff: `swarm pr-feedback https://github.com/ZaxbyHub/trainingapp/pull/42 continue from .swarm/pr-review/pr42/feedback-handoff.md` (if fixes are desired)
