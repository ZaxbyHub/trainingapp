## 🧪 swarm-pr-review — PR #38

Full review: 6 parallel explorer lanes → 2 independent reviewers. Deterministic signals: tests (63 files, 1108 passed ✅), typecheck ✅.

---

### 🛑 CRITICAL — F-1 (PRR-001, existing finding, **still unfixed**): Conversation switch data loss

**File:** `web_ui/src/pages/ChatPage.tsx:137-152`

The conversation-switch effect finalizes the in-flight assistant message (strips `isStreaming`) and calls `cancelActiveStream()`, but does **NOT** call `onSaveConversation`. The code comment says:

> *"We do NOT persist here — the in-flight stream's own onDone/onError will persist to the OWNING conversation id"*

This assumption is **incorrect**. `TokenStreamManager.cancel()` (`TokenStreamManager.ts:248-260`) only flushes the token buffer and clears timers — it **never invokes `onDone` or `onError`**. The partial assistant message lives in React state but is **never persisted to IndexedDB**.

**Impact:** Any user who clicks a different conversation in the sidebar while a response is being generated **irrecoverably loses the partial answer**. A page reload or navigation discards it entirely.

The second commit (c8524d8) addressed a **different** finding (F1: first-turn fast-complete fix). PRR-001 remains unaddressed.

**Fix direction:** The switch effect should persist the finalized turn, mirroring what `handleCancel` already does at lines 589-596:
```
onSaveConversation(owningConversationIdRef.current, finalized, ...)
```

---

### ⚠️ MEDIUM — F-2 (PRR-005, existing finding, still present): handleCancel stale snapshot

**File:** `web_ui/src/pages/ChatPage.tsx:582-597`

`handleCancel` captures `snapshot = messagesRef.current` **before** calling `cancelActiveStream()`. When cancel flushes the token buffer via `onToken`, those flushed tokens update `messagesRef.current` — but the `finalized` array is derived from the **stale** pre-cancel snapshot, overwriting the flushed-token state. Bounded to ~one flush interval of token loss (≤16ms visible / ≤100ms hidden tab).

**Fix direction:** Derive `finalized` from `messagesRef.current` *after* `cancelActiveStream()` completes, not from the pre-cancel snapshot.

---

### ⚠️ HIGH — 4 Existing Test Gaps Still Unaddressed

These four test gaps were identified in the prior review and remain unaddressed in this PR:

1. **PRR-006**: S2 persist-on-cancel / persist-on-unmount / persist-on-engine-switch paths have **zero tests**. The new `ChatPage.streaming-persistence.test.tsx` (567 lines) covers S1 (conversation-switch owning-id) and F1 (first-turn fast-complete) only.

2. **PRR-008**: U2 indexing cancel (`AbortController`) and progress state mapping in `DocumentsPage.tsx` have no test coverage. `DocumentsPage.indexing.test.tsx` exercises indexing flow and error paths but never triggers the cancel path.

3. **PRR-009**: DocumentsPage has ~11 `showToast` call sites (lines 100, 133, 300, 368, 522, 525, 669) — no test asserts a specific toast message fires. A developer could silently break toast UX and all tests would pass.

4. **PRR-010**: The U8a image-on-empty-corpus abstain guard (`rag-orchestrator.ts:386`) allows multimodal queries on empty corpus when images are attached. `rag-orchestrator.test.ts:1043-1067` covers zero-context abstention without images but **no test supplies images** to verify the non-abstention branch.

---

### 📝 MEDIUM — O-018 Claim Inaccuracy

PR body states: *"S4/S7 test files un-excluded from vitest.config.ts"*. The actual diff removes `src/lib/streaming/TokenStreamManager.test.ts` and `src/lib/llm/web-llm-service.test.ts` from the exclude list — neither of which is "S4/S7-named". The actual S4/S7 tests live in `ChatPage.streaming-persistence.test.tsx` (new file, never excluded).

### 📝 MEDIUM — S1 Test Timing Gap

The S1 conversation-switch test deliberately engineers timing where `onDone` fires before `cancelActiveStream` — the **opposite** of production ordering. The test validates the S1 owning-id fix but does **not** test the actual cancel-on-switch persistence path (which is the F-1 BLOCKER above).

### 📝 LOW — Dead Export

`db/conversations.ts:122` exports `updateTitle` — grep finds zero in-repo consumers. Consider removing if truly dead code.

---

### ✅ What The Review Confirmed Is Sound

| Area | Status |
|------|--------|
| **S1 F1 first-turn fix** | ✅ Verified correct — `handleSend` now awaits `saveMessages`, `owningConversationIdRef` set before `runGeneration` |
| **Engine-switch persist** | ✅ Confirmed working — `ChatPage.tsx:202-211` calls `onSaveConversation` |
| **Renderer XSS posture** | ✅ No `dangerouslySetInnerHTML`, no `rehype-raw`, no `innerHTML` anywhere |
| **URL allowlist** | ✅ Rejects `javascript:`, `data:`, `blob:`, `file:`, scheme-less, and relative URLs |
| **Error rendering** | ✅ Rendered as React children (escaped) — no HTML injection |
| **Tests** | ✅ 63 files, 1108 passed, 2 skipped, 0 failed |
| **Typecheck** | ✅ Clean pass |
| **Dependency air-gap** | ✅ 40+ new transitive deps (unified/micromark ecosystem); all MIT, pure ESM, no native modules |
| **Schema compatibility** | ✅ New `ChatMessage` fields optional; `LLMService` interface additive (optional method) |
| **S7 WebLLM abort** | ✅ `AbortController` → `interruptGenerate` listener correctly wired |
| **Conversation switch test** | ✅ Validates the S1 owning-id fix (no duplicate, correct target) |

---

### Summary of Required Fixes

1. **🛑 CRITICAL**: Add `onSaveConversation` call in conversation-switch effect (`ChatPage.tsx:137-152`)
2. **⚠️ MEDIUM**: Fix `handleCancel` to use `messagesRef.current` after cancel, not stale snapshot
3. **⚠️ HIGH**: Add S2 persist-path tests (cancel/unmount/engine-switch)
4. **⚠️ HIGH**: Add U2 cancel + progress tests
5. **⚠️ HIGH**: Add DocumentsPage toast assertion tests
6. **⚠️ HIGH**: Add U8a image-on-empty-corpus guard test
7. **📝 MEDIUM**: Correct PR body O-018 claim about un-excluded test files
8. **📝 LOW**: Consider removing dead `updateTitle` export
