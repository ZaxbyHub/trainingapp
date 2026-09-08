#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# desktop/repro/check-b2.sh — acceptance-check driver for issue #60
# (Workstream B2: Electron desktop shell hardening).
#
# Usage, from the REPO ROOT under Git Bash:
#   bash desktop/repro/check-b2.sh <check-id>
#
# Check ids and what they prove:
#   loopback-guard      AC1   vitest spec b2-loopback-guard.test.ts:
#                             missing/wrong X-Desktop-Token -> 401 BEFORE any
#                             backend delegate; Origin/Host mismatch
#                             (evil.example, localhost:<port>, LAN IP) -> 403
#                             regardless of token; pass-through returns null
#   loopback-origin     AC2   vitest spec b2-loopback-origin.test.ts: wrong
#                             origins (http(s)://evil.example, 'null', subdomain
#                             tricks) and wrong hosts (LAN IP, localhost:<port>)
#                             rejected 403 EVEN WITH a VALID token, before any
#                             backend call; valid token + allowed origin passes
#                             (same loopback-guard.ts seam as loopback-guard)
#   token-bridge        AC3  FIRST structural greps over desktop/main +
#                             desktop/preload (zero localStorage/sessionStorage
#                             hits; zero `?token=`/`&token=`/`#token=` URL-param
#                             delivery), THEN vitest spec b2-token-bridge.test.ts:
#                             token delivered only via contextBridge
#                             desktopApi.getAuthToken ->
#                             ipcRenderer.invoke('desktop:get-token')
#   navigation-lockdown AC4  vitest spec b2-navigation-lockdown.test.ts:
#                             will-navigate denies non-app:// targets;
#                             setWindowOpenHandler denies every window.open
#   csp                 AC5  vitest spec b2-csp.test.ts: strict
#                             content-security-policy on EVERY app:// response
#                             incl. 403/404; script-src has no 'unsafe-inline'
#                             (only the pinned sha256 theme-bootstrap script)
#                             and allows WASM via 'wasm-unsafe-eval'
#   token-lifecycle     AC7  vitest spec b2-token-lifecycle.test.ts:
#                             crypto.randomBytes(32) hex (64 chars), unique per
#                             mint, never persisted (fs spies) or logged
#                             (console spies)
#   security-config     AC8  vitest spec b2-security-config.test.ts: defaults
#                             tokenHeaderName 'X-Desktop-Token' + allowedOrigins
#                             ['app://*']; packaged builds refuse dev-only
#                             extra origins (env opt-in gated on not
#                             app.isPackaged)
#   AC6 (docs/security/desktop.md threat model) is DOCS_ONLY: intentionally
#   NOT an executable check id in this driver.
#
# Contract: the LAST line on stdout is exactly
#   DESKTOP-60 CHECK: PASS <id>
#   DESKTOP-60 CHECK: FAIL <id> <reason>
# Exit code 0 on PASS, 1 on FAIL. Uses no paths outside the repo.
#
# Invocation note: vitest MUST run with the desktop package as cwd so that
# desktop/vitest.config.ts applies (it carries the 'electron' ->
# desktop/test/electron-stub.ts alias). Verified on this tree that
# `npm --prefix <desktop> exec vitest ...` keeps the SPAWNING cwd (vitest then
# runs at the repo root WITHOUT the alias and even existing suites fail), so
# the driver uses `(cd <desktop> && ./node_modules/.bin/vitest run ...)`.
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ID="${1:-}"

fail() {
  echo "DESKTOP-60 CHECK: FAIL ${ID} ${1}"
  exit 1
}

if [ -z "$ID" ]; then
  echo "DESKTOP-60 CHECK: FAIL usage check-id-required-(loopback-guard|loopback-origin|token-bridge|navigation-lockdown|csp|token-lifecycle|security-config)"
  exit 1
fi

ensure_desktop_deps() {
  [ -d "${ROOT}/desktop/node_modules" ] && return 0
  npm --prefix "${ROOT}/desktop" install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
    || fail "desktop-npm-install-failed"
}

# Structural AC3 guard (always runs before the token-bridge spec): the token
# must never be parked in web storage or passed as a URL parameter anywhere in
# the production desktop source. Scope: desktop/main + desktop/preload only
# (fixtures/specs under desktop/src and the web_ui renderer's own localStorage
# use are not token delivery).
#
# Storage pattern notes: the match is storage-API USAGE shapes —
# `localStorage.` / `localStorage[` / `sessionStorage.` / `sessionStorage[`
# (method calls and bracket access, incl. window.localStorage.x) — rather than
# the bare word: a B1 doc comment in desktop/main/protocol.ts legitimately
# mentions "localStorage" when describing app:// scheme privileges, and a bare
# substring would fail every run for that comment, not for token storage.
token_storage_guard() {
  if grep -rnE "(localStorage|sessionStorage)[[:space:]]*(\.|\[)" \
      "${ROOT}/desktop/main" "${ROOT}/desktop/preload" >/dev/null 2>&1; then
    fail "token-storage-violation-localStorage-or-sessionStorage-access-in-desktop-main-or-desktop-preload"
  fi
  # URL-param delivery pattern: 'token=' preceded by ?, & or # (query or hash).
  # Anchored to a URL context so ordinary identifiers (const token = ...) and
  # header names never false-positive.
  if grep -rnE "[?&#]token=" \
      "${ROOT}/desktop/main" "${ROOT}/desktop/preload" >/dev/null 2>&1; then
    fail "token-storage-violation-token-as-url-parameter"
  fi
}

# Run exactly ONE vitest spec (path relative to the desktop package), stream
# its output, and on failure compose a STABLE reason:
#   - collection failed on module resolution -> 'module-missing-<sanitized
#     specifier>' (e.g. module-missing-main-security-token);
#   - otherwise -> 'vitest-exit-<rc>' plus '-saw-<marker>' for every
#     id-nominated behavioral marker actually present in the log (the markers
#     are substrings of the failing test names, e.g. desktopApi,
#     will-navigate, setWindowOpenHandler, content-security-policy).
run_spec() {
  spec_file="$1"  # e.g. b2-csp.test.ts
  markers="$2"    # space-separated stable substrings identifying behavioral REDs
  log="$(mktemp)"
  (cd "${ROOT}/desktop" && ./node_modules/.bin/vitest run "src/__tests__/${spec_file}") >"$log" 2>&1
  rc=$?
  cat "$log"
  if [ "$rc" -eq 0 ]; then
    rm -f "$log"
    return 0
  fi
  reason="vitest-exit-${rc}"
  missing="$(grep -oE "Cannot find module '[^']+'" "$log" | head -n 1 | sed -e "s/^Cannot find module '//" -e "s/'\$//")"
  if [ -n "$missing" ]; then
    reason="module-missing-$(printf '%s' "$missing" | sed -E -e 's#^(\.\./)+##' -e 's#[^A-Za-z0-9]+#-#g' -e 's#^-+##' -e 's#-+\$##')"
  else
    for m in $markers; do
      if grep -qi -e "$m" "$log" 2>/dev/null; then
        reason="${reason}-saw-${m}"
      fi
    done
  fi
  rm -f "$log"
  fail "$reason"
}

case "$ID" in
  loopback-guard)
    ensure_desktop_deps
    run_spec b2-loopback-guard.test.ts "loopback-guard"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  loopback-origin)
    ensure_desktop_deps
    run_spec b2-loopback-origin.test.ts "loopback-origin"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  token-bridge)
    ensure_desktop_deps
    token_storage_guard
    run_spec b2-token-bridge.test.ts "desktopApi"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  navigation-lockdown)
    ensure_desktop_deps
    run_spec b2-navigation-lockdown.test.ts "will-navigate setWindowOpenHandler"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  csp)
    ensure_desktop_deps
    run_spec b2-csp.test.ts "content-security-policy"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  token-lifecycle)
    ensure_desktop_deps
    run_spec b2-token-lifecycle.test.ts "token-lifecycle"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  security-config)
    ensure_desktop_deps
    run_spec b2-security-config.test.ts "security-config"
    echo "DESKTOP-60 CHECK: PASS ${ID}"
    exit 0
    ;;

  *)
    fail "unknown-check-id-${ID}"
    ;;
esac
