# PR Review Feedback Handoff — PR #31

/swarm pr-feedback https://github.com/ZaxbyHub/trainingapp/pull/31 continue from .swarm/pr-review/pr31-20260715/feedback-handoff.md

## PR Summary
fix(web_ui): settings page rebuild — Clear Cache, engine-aware status, theme, a11y (Issue #24)
Author: zaxbysauce | Branch: fix/web-ui-settings-page-rebuild-issue-24

## Verdict: APPROVED — no blocking issues

All 9 audit findings (F1–F9) are verified closed. 3 MEDIUM non-blocking findings remain.

## Confirmed Findings Requiring Fix

### F-001 (MEDIUM): Missing test for deleteNamespace rejection path
- File: `web_ui/src/pages/SettingsPage.tsx:692-728`, `SettingsPage.clearCache.test.tsx`
- The catch block sets `clearCacheResult: 'error'` but no test exercises this path
- Fix: `deleteNamespaceMock.mockRejectedValueOnce(...)` → assert "Could not clear all data" appears

### F-002 (MEDIUM): caches.delete rejection path untested
- File: `SettingsPage.test.tsx:215`, `SettingsPage.tsx:717-725`
- Cache-delete mock only resolves; `.catch(() => {})` suppression never exercised
- Fix: Add test where one `caches.delete` rejects

### F-003 (MEDIUM): deleteEdgeVecBlob silently resolves on failure
- File: `web_ui/src/pages/SettingsPage.tsx:164-217`
- All error paths (onerror, tx.onerror, catch) resolve promise → user sees "Cache cleared" on failure
- Fix: Make tx.onerror/onabort and req.onerror reject the promise

## Advisory Improvements (LOW)
1. ThemeContext.test.tsx: Assert `themePreference === 'system'` after OS change
2. SettingsPage.clearCache.test.tsx: Test onupgradeneeded/onerror for EdgeVec mock
3. Test stale prefix cleanup path (listStalePrefixes returns non-empty)
4. Tighten interval timing assertion (exact call count, not `> initialCalls`)

## Branch State
- Local HEAD: 8414d12 (up to date with remote)
- Base branch: master (a1826d68)
- MERGEABLE: true (no conflicts)
- mergeStateStatus: BLOCKED (branch protection requires review)
- CI: Web UI build+typecheck+security ✅, Python tests in progress
