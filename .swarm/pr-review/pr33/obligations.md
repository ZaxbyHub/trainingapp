# Obligation Ledger — PR #33

O-001 | PR body claim | Build succeeds (npm run build:offline passes) | web_ui/ | status: UNVERIFIED
O-002 | PR body claim | Typecheck passes (npx tsc --noEmit passes) | web_ui/ | status: UNVERIFIED
O-003 | PR body claim | Tests pass (60 files, 1017 passed, 1 skipped, 0 failed) | web_ui/ | status: UNVERIFIED
O-004 | PR body claim | No generated artifacts staged | . | status: UNVERIFIED
O-005 | PR body claim | No secrets (pre-push scan clean) | . | status: UNVERIFIED
O-006 | PR body claim | New code has tests (wllama-service.test.ts, offline-env.test.ts, embedding-service.test.ts) | web_ui/src/lib/llm/, web_ui/src/lib/models/, web_ui/src/lib/embeddings/ | status: UNVERIFIED
O-007 | PR body claim | HEAD request on 219 MB model file returns instant 200 | web_ui/scripts/start.ps1 | status: UNVERIFIED
O-008 | PR body claim | Range GET returns 206 Partial Content with correct Content-Range | web_ui/scripts/start.ps1 | status: UNVERIFIED
O-009 | PR body claim | COOP/COEP/CORP headers present on all responses | web_ui/scripts/start.ps1, web_ui/index.html | status: UNVERIFIED
O-010 | PR body claim | Path traversal blocked (/../../../etc/passwd → 403) | web_ui/scripts/start.ps1 | status: UNVERIFIED
O-011 | PR body claim | Previous reviewer (GLM-5.2) found 4 defects → all fixed | . | status: UNVERIFIED
O-012 | PR body claim | Memory budget ~600 MB (down from 1.5 GB) | PACKAGING.md, model-manifest.ts | status: UNVERIFIED
O-013 | Commit message | Model switch: LFM2-VL-1.6B → LiquidAI LFM2.5-VL-450M | model-manifest.ts, manifest.json, prepare-models.mjs, PACKAGING.md | status: UNVERIFIED
O-014 | Commit message | Offline distribution server (start.ps1, start.bat, start.command, serve-offline.mjs) | web_ui/scripts/* | status: UNVERIFIED
O-015 | Commit message | OPFS/embedding bug fixes (wllama InMemoryStorageBackend, ORT numThreads, Vite dev ORT) | wllama-service.ts, offline-env.ts | status: UNVERIFIED
O-016 | PR body claim | Engine-aware readiness messaging (wllama shows accurate guidance, not download prompt) | model-readiness.ts | status: UNVERIFIED
O-017 | PR body claim | wllama OPFS bypass via InMemoryStorageBackend works | wllama-service.ts | status: UNVERIFIED
O-018 | PR body claim | ONNX Runtime numThreads deadlock fix (force numThreads=1 when !crossOriginIsolated) | offline-env.ts | status: UNVERIFIED
O-019 | PR body claim | Vite dev-mode ORT wasm path fix | offline-env.ts | status: UNVERIFIED
O-020 | PR body claim | No generated artifacts staged | . | status: UNVERIFIED
