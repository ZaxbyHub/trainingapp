## Codebase Reality Check — Issue #26: Tier-0 Safety, Governance & Offline-Resilience

This issue captures a comprehensive **codebase reality check** performed against the current state of `master` (all prerequisite PRs #20–#23, #27–#30 merged). It assesses what infrastructure already exists for each of the 8 work items in the original epic (#26), what's missing, effort estimates, and product decisions that must be made before implementation.

**Date assessed:** 2026-07-15
**Branch assessed:** `master` (@ a1826d68)
**Prerequisite status:** ✅ All merged

---

## ✅ Foundation Already in Place

The following capabilities are fully built and **require no additional work**:

| Capability | Status | Location |
|-----------|--------|----------|
| ✅ Structured citation metadata | Fully built (PR-3/#22) | `CitationRef` type — `docId`, `chunkIndex`, `source`, `page`, `text` |
| ✅ Citation popover click-through | Fully built (PR-3/#22) | `SourceCitation.tsx` — shows chunk text on pill click with copy support |
| ✅ RAG abstention event | Fully built (PR-3/#22) | `RAGEvent` has `abstain` + `abstainReason` |
| ✅ Abstention data model | Fully built (PR-3/#22) | `ChatMessage.abstain`, `abstainReason`, `citations`, `sources` |
| ✅ Profile namespace system | Fully built (PR-4/#23) | `getProfilePrefix()`, stable localStorage prefix, `deleteNamespace()`, `listStalePrefixes()` |
| ✅ Conversation export | Fully built (PR-4/#23) | `conversation-export.ts` — JSON + Markdown download |
| ✅ Dexie conversation CRUD | Fully built | `db/conversations.ts` — IndexedDB via Dexie |
| ✅ Vitest fork pool isolation | Configured | `pool: 'forks'`, `maxForks: 2`, `isolate: true`, `memoryLimit: '3GB'` |
| ✅ Security scanning CI | Configured | GitHub Actions security workflow |
| ✅ Web UI build + typecheck CI | Configured | `npm run build`, `npm run typecheck:all` pass |

---

## Work Item 1 — Curated, Versioned Knowledge Base

**Epic reference:** "Ship a curated, versioned knowledge base instead of relying entirely on user uploads"

### What exists
- `EmbeddingService` in `lib/embeddings/` — the runtime embedding pipeline used for user-uploaded documents
- `VectorIndex` in `lib/search/` — vector index infrastructure
- `KeywordIndex` in `lib/search/` — keyword index infrastructure
- Build system (`vite.config.ts`, `scripts/prepare-models.mjs`) — existing model packaging at dist-time

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Build-time embedding script | No script that runs the embedding model at package time to index curated content | 🔴 Required |
| Pre-built vector index | No mechanism to ship a pre-built vector index in dist | 🔴 Required |
| Pre-built keyword index | No mechanism to ship a pre-built keyword index in dist | 🔴 Required |
| Base corpus + user upload merge | Runtime RAG pipeline has no base + supplement dual-source concept | 🔴 Required |
| Corpus version tracking | No version identifier for the curated corpus | 🟡 Needed |

### Effort estimate
**10–15 days.** This is the largest item in the epic. It requires:
1. A build-time script (Node.js, runs the same ONNX embedding model) that reads curated docs and produces pre-computed index files
2. Modifications to the runtime RAG orchestrator to load + merge base indexes with user-uploaded indexes
3. A corpus-version identifier surfaced wherever citations appear
4. Product sign-off on which documents constitute the curated corpus and their licensing terms

### Blockers
- 🔴 **Product decision required:** What documents go into the curated corpus? What are the licensing terms?
- 🔴 **Product decision required:** When user uploads conflict with the base corpus, which wins?

---

## Work Item 2 — Click-Through Citations

**Epic reference:** "Verifiable answers — click-through citations to exact source passages"

### What exists
- ✅ `CitationRef.text` — the chunk text field exists and is populated by the RAG pipeline
- ✅ `SourceCitation` popover — clicking a citation pill shows `cite.text` in a popover with copy
- ✅ RAG pipeline passes `chunks: SearchResult[]` with full source metadata to `complete` events

### What's missing
- The popover UX could be richer (side panel, modal, expandable inline block — UX choice, not an infrastructure gap)
- No corpus version indicator anywhere in the UI

### Effort estimate
**2–3 days.** Core infrastructure is already built by PR-3 (#22). This is UI polish plus adding a `corpusVersion` display field.

### Blockers
- None. UX choice (side panel vs modal vs inline) can be made during implementation.

---

## Work Item 3 — "Insufficient Evidence" Abstention Card

**Epic reference:** "Explicit insufficient evidence abstention card"

### What exists
- ✅ `RAGEvent` emits `abstain: true` + `abstainReason` when retrieval can't ground an answer
- ✅ `ChatMessage` carries `abstain` and `abstainReason` fields
- ✅ `ChatPage.tsx` consumes abstention data from the RAG pipeline (lines 201–202, 294–295)

### What's missing
- No visually distinct UI component renders when `abstain === true` — the abstention data passes through but the chat bubble looks the same as a normal answer
- Need a new `AbstentionCard` component that renders a distinct card (different background, explanatory text, suggested next steps)

### Effort estimate
**1–2 days.** The data pipeline is fully complete. This is purely a new React component + wiring it into the chat message render path. No architectural unknowns.

### Blockers
- None. Implementation-ready.

---

## Work Item 4 — Safety Rails for Out-of-Scope Questions

**Epic reference:** "Safety rails for out-of-scope questions"

### What exists
- Nothing. No guardrail, no classifier, no disclaimer, no configurable topic list.

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Clinical disclaimer in chat UI | Not present anywhere in the app | 🟡 Required |
| Out-of-scope topic classifier | No mechanism to detect clinical/dosing/diagnosis questions | 🟡 Required |
| Configurable topic list | No config file or array to manage blocked topics | 🟡 Required |
| System-prompt routing | Default RAG system prompt has no clinical-safety guardrails | 🟡 Required |

### Effort estimate
**3–5 days.** The technical implementation is straightforward:
1. A keyword-based pre-filter (configurable array of topic patterns)
2. A system-prompt branch that activates when a clinical topic is detected
3. A persistent visible disclaimer component in the chat UI (`<DisclaimerBanner>`)

### Blockers
- 🔴 **Product/clinical-governance sign-off REQUIRED.** The issue explicitly states: *"This item needs product/clinical-governance sign-off on the exact routing rules and disclaimer language before implementation — don't invent clinical-safety policy unilaterally."* **Do not start this item without sign-off.**

---

## Work Item 5 — Local Audit Log for Governance

**Epic reference:** "Local audit log for governance"

### What exists
- ✅ Dexie-based IndexedDB persistence (`db/conversations.ts`) — the storage foundation
- ✅ `conversation-export.ts` — export infrastructure (`downloadTextFile`, `exportAsJSON`, `downloadConversation`) is directly reusable
- ✅ `ConversationExport` interface — export schema can be extended for audit records

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Append-only audit store | No separate audit-specific Dexie table | 🟡 Required |
| Per-turn retrieval metadata | No recording of retrieved chunks, scores, or rank per Q&A turn | 🟡 Required |
| Corpus version tracking | No version field in audit records | 🟡 Required |
| Audit export function | No audit-specific export (`downloadAuditLog`) | 🟡 Required |
| Retention/expiry policy | No mechanism to purge old audit records | 🟡 Required |

### Effort estimate
**3–5 days.** Reuses existing Dexie patterns and export infrastructure. Export conduit is already built — the audit export can piggyback on `downloadTextFile` and `exportAsJSON` patterns.

### Blockers
- 🔴 **Product/compliance sign-off REQUIRED:** The issue states audit logs may contain incidental PHI. Retention policy, access control, and whether logs need to stay purely local vs. exportable are policy decisions, not engineering ones.

---

## Work Item 6 — Shared-Workstation Posture

**Epic reference:** "Shared-workstation posture"

### What exists
- ✅ `getProfilePrefix()` — stable localStorage-based profile prefix (PR-4/#23)
- ✅ `deleteNamespace()`, `listStalePrefixes()` — namespace management (PR-4/#23, PR-5/#24)
- ✅ Profile-scoped IndexedDB databases (`{prefix}-doc-qa-*`) — isolation foundation

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Profile picker UI | No UI for selecting/switching between profiles | 🟡 Required |
| Inactivity timeout | No timer to auto-clear conversation after N minutes idle | 🟡 Required |
| IndexedDB at-rest encryption | No WebCrypto key-derivation for sensitive payloads | 🟡 Evaluate |

### Effort estimate
**5–7 days.** The profile foundation is solid — the epic explicitly says this builds on PR-4's storage-namespace fix. Profile picker = new component + wiring to `localStorage`. Inactivity timeout = straightforward `useEffect` + `setTimeout`.

### Blockers
- 🟡 **Encryption decision needed:** Evaluate whether at-rest encryption (WebCrypto + key derived from profile secret) is required for the deployment's threat model before building it. The issue itself questions whether it's necessary.

---

## Work Item 7 — True Offline Resilience via Service Worker

**Epic reference:** "True offline resilience via service worker"

### What exists
- Nothing. No service worker, no offline shell, no `navigator.storage.estimate()` usage.

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Service worker registration | No SW at all — not even a skeleton | 🔴 Required |
| App shell offline loading | Currently relies on Vite dev server or static dist — no SW caching | 🔴 Required |
| `navigator.storage.estimate()` | Memory/pressure indicators are currently static/misclassified | 🟡 Required |
| COOP/COEP headers | Not handled in dev server or served build config | 🟡 Required |

### Effort estimate
**7–10 days.** Adding a service worker is a significant architectural change. The `coi-serviceworker` pattern (referenced in the epic) solves both offline + COOP/COEP simultaneously. Must coordinate with the existing `coiServiceWorker` in vite config if any exists (currently none).

Storage-estimate work is smaller and could be split into its own task.

### Blockers
- None (code-wise), but this touches the entire build pipeline and interaction model. Test coverage needs special attention (service workers are notoriously hard to test in vitest/jsdom).

---

## Work Item 8 — Quality Harness

**Epic reference:** "Quality harness"

### What exists
- ✅ Vitest infrastructure — fork pool, memory limits, 30s timeout
- ✅ Build CI — `typecheck:all` + `build` + `test` + packaging in CI
- ✅ Security scan CI

### What's missing
| Layer | Gap | Severity |
|-------|-----|----------|
| Golden Q&A evaluation set | No fixed set of representative questions with expected source docs | 🟡 Required |
| Build-time retrieval hit-rate gate | No threshold that gates the build on answer quality | 🟡 Required |
| Build-time citation accuracy gate | No threshold verifying citations resolve to correct sources | 🟡 Required |
| Playwright smoke test | No E2E test covering the full golden path | 🟡 Required |

### Effort estimate
**5–7 days.** Entirely additive — doesn't modify existing code. The golden set is a content curation task (representative tier-0 questions + correct source documents). Playwright test is independent infrastructure.

### Blockers
- 🟡 **Prerequisite:** Several test files remain excluded from CI (pre-existing failures from sibling PRs #21/#22/#23/#25). These must be resolved before a quality gate that fails the build can work reliably. The current excluded list:
  - `src/components/InferenceModeToggle.test.tsx`
  - `src/components/MarkdownRenderer.test.tsx`
  - `src/components/SourceCitation.test.tsx`
  - `src/pages/ChatPage.test.tsx` (and variants)
  - `src/pages/DocumentsPage.test.tsx`
  - `src/lib/streaming/TokenStreamManager.test.ts`
  - `src/lib/inference/InferenceModeContext.test.tsx`
  - `src/lib/processing/docx-extractor.test.ts` (and xlsx/pptx)
  - `src/lib/llm/web-llm-service.test.ts`
  - `src/lib/llm/webgpu-watchdog.test.ts`
  - `src/test/verification/text-chunker.task44.test.ts`

---

## Recommended Execution Order

| Priority | Item | Effort | Risk | Product Decision Needed? |
|----------|------|--------|------|------------------------|
| 🥇 1st | **3. Abstention Card** | 1–2 days | Low | No — ready to implement |
| 🥇 2nd | **2. Click-Through Citations** | 2–3 days | Low | No — UX choice only |
| 🥈 3rd | **5. Audit Log** | 3–5 days | Medium | **YES — retention/PHI policy** |
| 🥈 4th | **8. Quality Harness** | 5–7 days | Medium | No — unblock excluded tests first |
| 🥉 5th | **4. Safety Rails** | 3–5 days | Low (code) | **YES — clinical disclaimer sign-off** |
| 🥉 6th | **6. Shared-Workstation** | 5–7 days | Medium | **YES — encryption threat model** |
| 🥉 7th | **7. Service Worker** | 7–10 days | High | No — but significant scope |
| 🥉 8th | **1. Curated Knowledge Base** | 10–15 days | High | **YES — corpus content/licensing** |

**Quick wins first (1–2 weeks):** Items 3 + 2 can ship rapidly since all infrastructure is already in place from PRs #21–#23. These deliver visible user value (abstention card, corpus version indicator) with minimal risk.

**Parallel track (requires product input):** Items 4, 5, and 6 all need product/compliance sign-off. Start the conversations now so decisions are ready when the quick wins are done.

**Heavy items (reserve for dedicated sprints):** Items 1 and 7 are significant architectural efforts that deserve focused planning cycles.

---

## Appendix: File Map

| Work Item | Primary Files to Touch | New Files Needed |
|-----------|----------------------|------------------|
| 1. Curated KB | `lib/rag/rag-orchestrator.ts`, `lib/embeddings/embedding-service.ts`, `vite.config.ts` | `scripts/prepare-corpus.mjs`, corpus data directory |
| 2. Citations | `components/SourceCitation.tsx`, `pages/ChatPage.tsx` | (minor changes) |
| 3. Abstention | `components/ChatMessageBubble.tsx`, `pages/ChatPage.tsx` | `components/AbstentionCard.tsx` |
| 4. Safety Rails | `lib/rag/rag-orchestrator.ts`, `pages/ChatPage.tsx` | `lib/safety/` module, `components/DisclaimerBanner.tsx` |
| 5. Audit Log | `db/conversations.ts`, `lib/export/conversation-export.ts` | `db/audit-log.ts`, `lib/export/audit-export.ts` |
| 6. Shared WS | `lib/storage/profile.ts`, `pages/SettingsPage.tsx` | `components/ProfilePicker.tsx` |
| 7. Service Worker | `vite.config.ts`, `index.html` | `sw.ts` (or `coi-serviceworker.js`) |
| 8. Quality Harness | `vitest.config.ts`, CI workflow | `test/golden-set/` data, Playwright config |
