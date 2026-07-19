# PR #39 Review Handoff — feedback-handoff.md

/swarm pr-feedback https://github.com/ZaxbyHub/trainingapp/pull/39 continue from .swarm/pr-review/pr39/feedback-handoff.md

## Verdict: NEEDS_REVISION

## Critical Findings

### F-1 (CRITICAL): Model file exceeds 2 GB ArrayBuffer ceiling
The PR claims Q4_K_M is ~1.5 GB. Reviewer verification of upstream HuggingFace repo (unsloth/gemma-4-E2B-it-GGUF) shows Q4_K_M is ~3.1 GB — exceeding wllama's 2 GB/file limit. Either use a smaller quant or implement gguf-split sharding.

### F-2 (HIGH): Memory budget insufficient
model-readiness.ts budgets 2.5 GB. Actual file sizes: GGUF ~3.1 GB + mmproj ~986 MB + KV cache ~280 MB. Budget must be recalculated.

### F-3 (MEDIUM): mmproj size mismatch
PR claims ~150 MB; upstream provides ~986 MB files. Specify exact projector filename in PACKAGING.md.

## Stale Comments
- wllama-service.ts:76: "219MB GGUF" → ~3.1 GB
- rag-orchestrator.ts:125: "DEFAULT_N_CTX (4096)" → 8192
- .github/workflows/web-ui.yml:72: "LFM2.5-VL" → Gemma 4
- rag-orchestrator.test.ts:1185: "n_ctx=4096" → 8192
