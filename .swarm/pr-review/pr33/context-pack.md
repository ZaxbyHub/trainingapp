# PR Review Context Pack — PR #33

## Scope
- **PR**: https://github.com/ZaxbyHub/trainingapp/pull/33
- **Title**: fix(web_ui): switch to LFM2.5-VL-450M, add offline distribution server, fix OPFS/embedding bugs
- **Base**: master | **Head**: fix/web-ui-model-switch-offline-distribution
- **Merge base**: a1826d68 | **Head commit**: 203e6a07
- **Commit range**: a1826d68..203e6a07
- **Files changed**: 20 (600 additions, 57 deletions)
- **Mergeable**: MERGEABLE | **Merge state**: BLOCKED (behind master)
- **Reviews**: none | **State**: OPEN

## Changed Files (20)

| File | Changes | Type |
|------|---------|------|
| PACKAGING.md | 9+/12- | MODIFIED |
| web_ui/public/models/README.md | 3+/5- | MODIFIED |
| web_ui/public/models/manifest.json | 4+/4- | MODIFIED |
| web_ui/scripts/README.txt | 56+ | ADDED |
| web_ui/scripts/prepare-models.mjs | 6+/6- | MODIFIED |
| web_ui/scripts/serve-offline.mjs | 131+ | ADDED |
| web_ui/scripts/start.bat | 5+ | ADDED |
| web_ui/scripts/start.command | 18+ | ADDED |
| web_ui/scripts/start.ps1 | 232+ | ADDED |
| web_ui/src/lib/embeddings/embedding-service.test.ts | 6+/2- | MODIFIED |
| web_ui/src/lib/llm/model-readiness.test.ts | 3+/1- | MODIFIED |
| web_ui/src/lib/llm/model-readiness.ts | 19+/7- | MODIFIED |
| web_ui/src/lib/llm/wllama-service.test.ts | 5+/2- | MODIFIED |
| web_ui/src/lib/llm/wllama-service.ts | 64+/3- | MODIFIED |
| web_ui/src/lib/models/model-manifest.ts | 4+/5- | MODIFIED |
| web_ui/src/lib/models/offline-env.test.ts | 7+/1- | MODIFIED |
| web_ui/src/lib/models/offline-env.ts | 21+/2- | MODIFIED |
| web_ui/src/lib/models/probe.test.ts | 2+/2- | MODIFIED |
| web_ui/src/pages/ChatPage.overlay.test.tsx | 2+/2- | MODIFIED |
| web_ui/src/pages/SettingsPage.test.tsx | 3+/3- | MODIFIED |

## PR Body Claims (Obligation Candidates)
1. Build succeeds: `npm run build:offline` — PASS
2. Typecheck passes: `npx tsc --noEmit` — PASS
3. Tests pass: `npx vitest run` — 60 files, 1017 passed, 1 skipped, 0 failed
4. No generated artifacts staged
5. No secrets (pre-push scan clean)
6. New code has tests: wllama-service.test.ts, offline-env.test.ts, embedding-service.test.ts
7. HEAD request on 219 MB model file → instant 200
8. Range GET on model → 206 Partial Content with correct Content-Range
9. COOP/COEP/CORP headers present on all responses
10. Path traversal blocked (`/../../../etc/passwd` → 403)
11. Previous reviewer (GLM-5.2) found 4 defects → all fixed
12. Previous critic (GLM-5.2): APPROVE

## PR Body Categories
### 1. Model switch: LFM2-VL-1.6B → LiquidAI LFM2.5-VL-450M
- model.gguf: LFM2.5-VL-450M Q4_K_M (229 MB)
- mmproj.gguf: vision projector Q8_0 (99 MB)
- Updated: LLM_MODEL_DIR, manifest, prepare-models, tests, PACKAGING.md, model README

### 2. Offline distribution infrastructure
- start.ps1: zero-dependency PowerShell HttpListener static server (COOP/COEP/CORP, HEAD, Range, streaming)
- start.bat: double-click Windows launcher
- start.command: Mac/Linux launcher (requires Node.js)
- serve-offline.mjs: zero-dependency Node server alternative
- README.txt: plain-English instructions

### 3. Bug fixes for airgapped/offline operation
- Engine-aware readiness messaging (wllama no longer shows download prompt for GGUF not found)
- wllama OPFS bypass via InMemoryStorageBackend (custom CacheManager)
- ONNX Runtime numThreads deadlock fix (force numThreads=1 when !crossOriginIsolated)
- Vite dev-mode ORT fix (wasmPaths to node_modules in dev, /models/ort/ in prod)
- Memory budget update: ~600 MB (down from 1.5 GB)

## Deterministic Signals Needed
- [ ] Test results
- [ ] Build check
- [ ] Typecheck
- [ ] Lint
- [ ] npm audit / dependency audit
- [ ] Secrets scan
