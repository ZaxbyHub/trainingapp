# PR Review Context Pack — PR #38

## Scope
- **PR**: https://github.com/ZaxbyHub/trainingapp/pull/38
- **Title**: fix(web_ui): chat correctness & UX overhaul — renderer, streaming/persistence integrity, a11y (Issue #36)
- **Base**: master | **Head**: fix/web-ui-chat-correctness-ux-overhaul-issue-36
- **Merge base**: a1826d68 | **Head commit**: c8524d8f
- **Commit range**: a1826d68..c8524d8f
- **Files changed**: 45 (4,659 additions, 817 deletions)
- **Diff lines**: 7,884
- **Commits**: 2 (5f81f55 + c8524d8 — second commit addresses critic F1 findings)
- **Mergeable**: MERGEABLE | **Merge state**: BLOCKED (behind master)
- **Reviews**: none official | **Comments**: 1 (swarm-pr-review from zaxbysauce — REQUEST_CHANGES with PRR-001 BLOCKER + test gaps)
- **Closes**: #36

## Key PR Body Claims (Obligations)
O-001: Zero `dangerouslySetInnerHTML` / no `rehype-raw` added
O-002: Scheme allowlist + tests — urlTransform allows http|https|mailto|tel; rejects scheme-less/relative/javascript:/data:/blob:/file:
O-003: Auto-scroll behavior preserved (windowing is render-only)
O-004: New-Chat non-empty→empty guard preserved
O-005: IME/Enter handling untouched (only placeholder text changed)
O-006: wllama abort path untouched (only WebLLM gained abort listener)
O-007: Air-gap packaging — react-markdown + remark-gfm are pure-JS ESM; validate-build.mjs greps no CDN hostnames
O-008: No vector re-index (frontend-only; single rag-orchestrator.ts line for U8a abstain guard)
O-009: S1 CRITICAL fix — thread owning conversation id + messages snapshot; handleSend awaits send-time save; cancel stream on conversation switch; saveMessages takes explicit conversationId
O-010: S2 — persist on send/cancel/error/unmount/engine-switch
O-011: S3 — strip isStreaming before persistence; finalize flags on cleanup
O-012: S4 — cancel() flushes buffered tokens before clearing; overflow flushes; hidden-tab setTimeout fallback
O-013: S5 — render-only windowing in ChatMessageList (full history persists)
O-014: S6 — structured error field + styled error card
O-015: S7 — WebLLM interrupt wired (abort→interruptGenerate listener; cancelActiveStream calls interrupt())
O-016: S8 — thread `now` prop so timestamps recompute
O-017: Tests — 1108 passed, 2 skipped (63 files)
O-018: S4/S7 test files un-excluded
O-019: S1 first-turn regression test (true regression — reverting fix makes it fail)

## Existing Review Findings (zaxbysauce — swarm-pr-review)
### BLOCKER
- PRR-001 (HIGH): Mid-stream conversation switch drops partial assistant turn — switch effect finalizes+cancels but doesn't persist; cancel() never fires done/error; generator early-returns before complete()

### Should-fix
- PRR-005 (MEDIUM): handleCancel captures snapshot BEFORE cancelActiveStream; S4 cancel-flush reassigns messagesRef.current; finalized array from stale snapshot overwrites correct one
- PRR-006 (HIGH test gap): S2 persist-on-cancel/unmount/engine-switch paths have zero tests
- PRR-008 (HIGH test gap): U2 indexing cancel + progress mapping untested
- PRR-009 (HIGH test gap): DocumentsPage toast call sites untested
- PRR-010 (HIGH test gap): U8a image-on-empty-corpus abstain guard untested

### What's sound
- Renderer XSS posture clean, urlTransform tested, semantic DOM tests genuine
- S1 no-overwrite+no-duplicate fix verified correct
- S4+S7 implementation + tests genuine
- All invariants met

### Rejected
- PRR-002 (unproven), PRR-003 (~12ms latency), PRR-004 (lifecycle misread), PRR-012/015/016/017 (INFO/LOW)

## Changed Files by Category

### Renderer (react-markdown + remark-gfm)
- src/components/MarkdownRenderer.tsx: 358+/375- (complete rewrite)
- src/components/MarkdownRenderer.test.tsx: 158+/9-
- package.json: +2 deps (react-markdown, remark-gfm)
- package-lock.json: 1526+/73- (lockfile update)

### Streaming & Persistence
- src/pages/ChatPage.tsx: 243+/63- (core send/cancel/switch/persist logic)
- src/pages/ChatPage.streaming-persistence.test.tsx: 567+ (NEW — S1/S2/S4/S7 tests)
- src/lib/streaming/TokenStreamManager.ts: 36+/9-
- src/lib/streaming/TokenStreamManager.test.ts: 154+/43-
- src/lib/llm/web-llm-service.ts: 27+
- src/lib/llm/web-llm-service.test.ts: 142+/3-
- src/db/conversations.ts: 1+/25-
- src/hooks/useConversations.ts: 77+/19-
- src/hooks/useConversations.test.ts: 153+/6-
- src/types/chat.ts: 5+
- src/types/llm.ts: 4+

### UX / Accessibility
- src/components/ChatMessageList.tsx: 96+/29- (windowing + persist fix)
- src/components/ChatMessageList.test.tsx: 64+
- src/components/ChatMessageBubble.tsx: 55+/7- (error card)
- src/components/DocumentList.tsx: 217+/100- (delete confirm, empty states)
- src/components/DocumentList.test.tsx: 32+/1-
- src/components/DropZone.tsx: 22+/3-
- src/components/InferenceModeToggle.tsx: 27+/2-
- src/components/SidebarConversationItem.tsx: 14+/2-
- src/components/StreamingIndicator.tsx: 50+/1-
- src/components/ChatInput.tsx: 1+/1-
- src/components/ChatInput.test.tsx: 22+/22-
- src/hooks/useDocumentCount.ts: 74+ (NEW)
- src/pages/DocumentsPage.tsx: 103+/3- (indexing progress, toasts)
- src/pages/DocumentsPage.indexing.test.tsx: 46+/7-
- src/App.tsx: 53+/1- (init-error banner)
- src/App.test.tsx: 3+/3-
- src/styles/tokens.css: 17+/1-

### Other
- src/utils/relativeTime.ts: 9+/2-
- src/lib/rag/rag-orchestrator.ts: 6+/1- (U8a abstain guard)
- src/pages/ChatPage.init.test.tsx: 8+
- src/pages/ChatPage.keyboard-guard.test.tsx: 4+
- src/pages/ChatPage.overlay.test.tsx: 4+
- src/pages/ChatPage.rag.test.tsx: 52+ (NEW)
- src/pages/ChatPage.server-mode.test.tsx: 80+ (NEW)
- src/pages/ChatPage.shortcuts.test.tsx: 40+ (NEW)
- src/pages/ChatPage.test.tsx: 84+
- src/pages/ChatPage.verification-3.3.test.tsx: 16+
- vitest.config.ts: 0+/2- (S4/S7 un-excluded)
- src/hooks/useKeyboardShortcuts.ts: 4+/1-
- README.md: 3+/3-
