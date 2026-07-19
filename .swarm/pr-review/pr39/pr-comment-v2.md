## 🧪 swarm-pr-review — PR #39 (Full 6-Lane Review)

**Verdict: NEEDS_REVISION** — 1 CRITICAL, 2 HIGH findings.

Full review: 6 parallel explorer lanes → independent reviewer. Deterministic signals: tests (1117/2 skipped ✅), typecheck ✅.

---

### 🛑 CRITICAL — F-1: Model file exceeds wllama's 2 GB/file ArrayBuffer limit

**Files:** `PACKAGING.md:140`, `model-manifest.ts:111-112`

The PR claims the Gemma 4 E2B-it Q4_K_M is **~1.5 GB** (PACKAGING.md line 140, model-manifest.ts line 112). According to the upstream huggingface repo (`unsloth/gemma-4-E2B-it-GGUF`), the Q4_K_M quants are actually **~3.1 GB** (3,106,738,272 bytes). This exceeds wllama's **2 GB/file `ArrayBuffer` ceiling**, meaning a single unsplit `model.gguf` **cannot be loaded** by wllama at all.

The model would need to be split with `llama-gguf-split` (as the old PACKAGING.md described for larger quants), or a smaller quant must be used.

### ⚠️ HIGH — F-2: Memory budget insufficient

**File:** `web_ui/src/lib/llm/model-readiness.ts:72-75`

The memory budget of **2.5 GB** is insufficient for the actual model:
- Q4_K_M GGUF: **~3.1 GB** (not ~1.5 GB as claimed)
- mmproj projector: **~986 MB** per upstream (`mmproj-BF16.gguf`/`mmproj-F16.gguf`), not ~150 MB as claimed
- KV cache (35 layers, 1 KV head, 8192 ctx): ~280 MB

Total peak is well over 4 GB, leaving insufficient headroom on 8 GB target boxes. The budget must be recalculated against the actual file sizes.

### ⚠️ MEDIUM — F-3: mmproj size mismatch

**File:** `PACKAGING.md:141`

The PR documents the mmproj as "~150 MB" but upstream provides `mmproj-BF16.gguf`/`mmproj-F16.gguf` at **~986 MB each**. The exact required projector filename is also not specified — users building from source need a precise filename to use.

### 📝 LOW — Stale Comments

- `wllama-service.ts:76` — still says "219MB GGUF" (old model size)
- `rag-orchestrator.ts:125` — still says "DEFAULT_N_CTX (4096)" (old context value)
- `.github/workflows/web-ui.yml:72` — CI comment still references "LFM2.5-VL"
- `rag-orchestrator.test.ts:1185` — test comment references `n_ctx=4096`

### ✅ Verified Sound

| Check | Result |
|-------|--------|
| **All source references** | Zero stale `lfm`/`LFM`/`450m` in web_ui source/test files |
| **model-manifest.ts paths** | Consistent — `LLM_MODEL_DIR` → `gemma-4-e2b-it` |
| **manifest.json** | Paths, id, label correctly updated |
| **prepare-models.mjs** | Source/dest dirs correct |
| **Test assertions** | All test files updated correctly (probe, wllama-service, SettingsPage, ChatPage.overlay, rag-orchestrator F11) |
| **Cross-module coupling** | Disproved by reviewer — rag-orchestrator importing DEFAULT_N_CTX is intentional |
| **Secrets scan** | No secrets, tokens, or credentials in diff |
| **Security** | No CDN references, no injection vectors, no path traversal risks |

### Required Fixes

1. **🛑 CRITICAL**: Verify Gemma 4 E2B-it Q4_K_M actual file size. If ~3.1 GB, either use a smaller quant (Q3_K_M, Q2_K) that fits under 2 GB, or implement `llama-gguf-split` sharding as previously documented.
2. **⚠️ HIGH**: Recalculate memory budget in model-readiness.ts using actual file sizes (GGUF + mmproj + KV cache + WASM overhead).
3. **⚠️ MEDIUM**: Update PACKAGING.md mmproj size and specify exact projector filename.
4. **📝 LOW**: Fix stale comments (wllama-service.ts:76, rag-orchestrator.ts:125, web-ui.yml:72, rag-orchestrator.test.ts:1185).
