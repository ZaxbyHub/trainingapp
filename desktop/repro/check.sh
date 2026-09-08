#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# desktop/repro/check.sh — acceptance-check driver for issue #59
# (Electron scaffold with secure defaults and CI installer artifact).
#
# Usage, from the REPO ROOT under Git Bash:
#   bash desktop/repro/check.sh <check-id>
#
# Check ids and what they prove:
#   secure-defaults  AC3  vitest spec: BrowserWindow webPreferences flags locked
#                          down + preload exposes one `trainingapp` namespace
#   single-instance  AC4  vitest spec: requestSingleInstanceLock consulted, quit
#                          on denial, second-instance focuses/restores window
#   app-protocol     AC5  vitest spec: app:// handler serves dist with MIME
#                          types and refuses path traversal outside root
#   dev-wiring       AC1  structural: desktop:dev script exists, main/index.ts
#                          references the http://localhost:5173 dev URL,
#                          preload/index.ts exists
#   installer-build  AC2  local proxy: builds web_ui, stages renderer, runs
#                          electron-builder (NSIS x64, unsigned) and verifies a
#                          *.exe exists in the configured output dir
#   bench-size-row   AC6  bench/RESULTS.md has a table row naming a .exe
#                          installer, a MB size, and a 2026- date
#
# Contract: the LAST line on stdout is exactly
#   DESKTOP-59 CHECK: PASS <id> [detail]
#   DESKTOP-59 CHECK: FAIL <id> <reason>
# Exit code 0 on PASS, 1 on FAIL. Uses no paths outside the repo.
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ID="${1:-}"

fail() {
  echo "DESKTOP-59 CHECK: FAIL ${ID} ${1}"
  exit 1
}

if [ -z "$ID" ]; then
  echo "DESKTOP-59 CHECK: FAIL usage check-id-required-(secure-defaults|single-instance|app-protocol|dev-wiring|installer-build|bench-size-row)"
  exit 1
fi

# Shared preflight: the production seams must exist before anything slow runs.
require_impl_files() {
  [ -f "${ROOT}/desktop/main/index.ts" ] || fail "implementation-files-missing"
  [ -f "${ROOT}/desktop/main/protocol.ts" ] || fail "implementation-files-missing"
}

ensure_desktop_deps() {
  [ -d "${ROOT}/desktop/node_modules" ] && return 0
  npm --prefix "${ROOT}/desktop" install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
    || fail "desktop-npm-install-failed"
}

case "$ID" in
  secure-defaults | single-instance | app-protocol)
    require_impl_files
    ensure_desktop_deps
    npm --prefix "${ROOT}/desktop" run "test:${ID}"
    rc=$?
    [ "$rc" -eq 0 ] || fail "vitest-exit-${rc}"
    echo "DESKTOP-59 CHECK: PASS ${ID}"
    exit 0
    ;;

  dev-wiring)
    require_impl_files
    # (a) desktop/package.json declares a desktop:dev script
    (
      cd "${ROOT}/desktop" &&
        node -e "const p=require('./package.json'); process.exit(p.scripts && typeof p.scripts['desktop:dev']==='string' && p.scripts['desktop:dev'].length>0 ? 0 : 1)"
    ) || fail "desktop-package-json-desktop-dev-script-missing"
    # (b) the main process references the browser dev URL (or its env override)
    grep -q 'http://localhost:5173' "${ROOT}/desktop/main/index.ts" \
      || fail "dev-url-http-localhost-5173-not-referenced-in-desktop-main-index-ts"
    # (c) the preload entry exists
    [ -f "${ROOT}/desktop/preload/index.ts" ] || fail "desktop-preload-index-ts-missing"
    echo "DESKTOP-59 CHECK: PASS dev-wiring"
    exit 0
    ;;

  installer-build)
    require_impl_files
    [ -f "${ROOT}/desktop/electron-builder.yml" ] || fail "implementation-files-missing"
    grep -q 'com\.zaxbyhub\.trainingapp' "${ROOT}/desktop/electron-builder.yml" \
      || fail "app-id-com.zaxbyhub.trainingapp-missing-in-electron-builder-yml"
    # web_ui renderer build (deps first if needed)
    if [ ! -d "${ROOT}/web_ui/node_modules" ]; then
      npm --prefix "${ROOT}/web_ui" ci --no-audit --no-fund >/dev/null 2>&1 \
        || fail "web-ui-npm-ci-failed"
    fi
    npm --prefix "${ROOT}/web_ui" run build || fail "web-ui-build-failed"
    # desktop:build must build/copy the renderer into the staging area and run
    # electron-builder for the unsigned NSIS x64 installer.
    npm --prefix "${ROOT}/desktop" run desktop:build || fail "desktop-build-failed"
    # Locate the configured electron-builder output dir (default: release/).
    out_rel="$(grep -E '^[[:space:]]*output:' "${ROOT}/desktop/electron-builder.yml" | head -n 1 | cut -d: -f2- | tr -d ' \t"'\''\r')"
    [ -n "$out_rel" ] || out_rel="release"
    out_dir="${ROOT}/desktop/${out_rel}"
    exe="$(find "$out_dir" -type f -name '*.exe' 2>/dev/null | head -n 1)"
    [ -n "$exe" ] || fail "no-installer-exe-found-under-desktop-${out_rel}"
    size_bytes="$(wc -c < "$exe" | tr -d '[:space:]')"
    size_mb="$(awk -v b="$size_bytes" 'BEGIN { printf "%.1f", b / 1048576 }')"
    echo "DESKTOP-59 CHECK: PASS installer-build size_mb=${size_mb} artifact=$(basename "$exe")"
    exit 0
    ;;

  bench-size-row)
    [ -f "${ROOT}/desktop/electron-builder.yml" ] || fail "implementation-files-missing"
    # A markdown table row (starts with '|') that names a .exe installer AND a
    # MB size AND a 2026- date (the issue requires artifact, size, date).
    row="$(grep '^|' "${ROOT}/bench/RESULTS.md" | grep '\.exe' | grep 'MB' | grep '2026-' | head -n 1)"
    [ -n "$row" ] || fail "bench-RESULTS-md-has-no-installer-size-row-exe-plus-MB-plus-2026-date"
    echo "$row"
    echo "DESKTOP-59 CHECK: PASS bench-size-row"
    exit 0
    ;;

  *)
    fail "unknown-check-id-${ID}"
    ;;
esac
