# PR #43 Review Handoff — feedback-handoff.md

/swarm pr-feedback https://github.com/ZaxbyHub/trainingapp/pull/43 continue from .swarm/pr-review/pr43/feedback-handoff.md

## Verdict: NEEDS_REVISION (updated)

## Critical Findings

### F-1 (CRITICAL): IS_AIRGAP guard missing
web_ui/src/lib/llm/web-llm-service.ts:186 — `await import('@mlc-ai/web-llm')` unconditional. IS_AIRGAP defined but unused (airgap.ts:22).

### N-1 (CRITICAL): embedding.worker.ts is dead code
web_ui/src/lib/embeddings/embedding.worker.ts (162 lines) — NOT referenced by any code. No `new Worker(new URL(...))` exists. embedding-service.ts still runs on main thread. Zero test coverage (no Worker polyfill in Vitest). No dispose/terminate path.

## High Findings
### F-2 (HIGH): validate-build --airgap silently ignored
build-airgap.mjs:60 passes --airgap but validate-build.mjs:54-60 doesn't process it.

### F-3 (HIGH): IsolationBanner not mounted
IsolationBanner.tsx exists but ChatPage.tsx has zero references.

### F-4 (HIGH): R4/R5/R6/R7/R8/P1 phantom claims
keyword-index.ts:102 still tokenize:'full'; text-chunker.ts:45 overlap=100; rag-orchestrator.ts:159 CHARS_PER_TOKEN=4; vector-index.ts:32 VERSION=2; browser-compat.ts/memory-aware.ts not deleted; no .github/workflows changes.

## Medium Findings
- N-3: duplicate-guard.ts zero test coverage
- N-6: npm run build:airgap not registered
- N-7: api_server.py history field no size constraints

## Branch State
- mergeStateStatus: BLOCKED (branch protection)
- mergeable: MERGEABLE
- CI: PASS
