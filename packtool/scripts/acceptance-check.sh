#!/usr/bin/env bash
# Acceptance-check driver for issue #77 (Storyline extractor), one AC per run.
#
# Usage (from repo root):
#   bash packtool/scripts/acceptance-check.sh <AC-ID>     # AC1 .. AC8
#
# Behavior:
#   1. Base-tree sentinel: if packtool/storyline/decode.ts does not exist,
#      print "CHECK <AC-ID>: FAIL packtool/storyline not implemented (base tree)"
#      and exit 1 (this line is the --expect match for every check on the
#      pre-implementation tree).
#   2. Install deps when missing (npm ci --prefix packtool).
#   3. Rebuild before every run when stale (missing dist/cli.js or any
#      packtool/**/*.ts newer than it — PRR-004 fix: scan all of packtool,
#      not just storyline/) — staleness fakes green.
#   4. Run exactly the one AC's vitest file (PACKTOOL_AC selects it in
#      packtool/vitest.config.ts); print "CHECK <AC-ID>: PASS" / ": FAIL".
#      On FAIL, include the first line of the captured stderr so the failure
#      cause is diagnosable from the CHECK line alone (PRR-005 fix).

set -u

AC_ID="${1:-}"
case "$AC_ID" in
  [Aa][Cc][1-8]) ;;
  *)
    echo "usage: bash packtool/scripts/acceptance-check.sh <AC1|...|AC8>" >&2
    exit 2
    ;;
esac
AC_NUM="${AC_ID: -1}"
AC_UPPER="AC${AC_NUM}"
AC_LOWER="ac${AC_NUM}"

# 1. Base-tree sentinel: implementation must exist before anything else runs.
if [ ! -f packtool/storyline/decode.ts ]; then
  echo "CHECK ${AC_UPPER}: FAIL packtool/storyline not implemented (base tree)"
  exit 1
fi

# PRR-005 fix: structured FAIL output that includes the captured stderr's
# first error line so automated diagnosis from a single CHECK line is possible.
fail() {
  local last="$1"
  if [ -n "$last" ]; then
    echo "CHECK ${AC_UPPER}: FAIL ${last}"
  else
    echo "CHECK ${AC_UPPER}: FAIL"
  fi
  exit 1
}

# 2. Dependencies (package-lock.json is committed).
if [ ! -d packtool/node_modules ]; then
  if ! npm ci --prefix packtool 2>&1; then
    fail "npm ci: $(npm ci --prefix packtool 2>&1 | tail -1)"
  fi
fi

# 3. Rebuild when stale so a stale dist/ can never fake green.
# PRR-004 fix: scan all of packtool/ (not just storyline/) so a cli.ts-only
# edit triggers a rebuild.
STALE_SRC="$(find packtool -name '*.ts' -path 'packtool/storyline/*' -newer packtool/dist/cli.js -print -quit 2>/dev/null)"
STALE_CLI="$(find packtool -maxdepth 1 -name '*.ts' -newer packtool/dist/cli.js -print -quit 2>/dev/null)"
if [ ! -f packtool/dist/cli.js ] || [ -n "${STALE_SRC}" ] || [ -n "${STALE_CLI}" ]; then
  if ! npm run build --prefix packtool 2>&1; then
    fail "build: $(npm run build --prefix packtool 2>&1 | tail -1)"
  fi
fi

# 4. Run exactly one AC's test file. Capture stderr so PRR-005 can surface a
#    diagnostic first-line on FAIL.
command -v npx >/dev/null 2>&1 || fail "npx not found"
LOG="$(mktemp 2>/dev/null || echo /tmp/packtool-ac.$$.log)"
if ! PACKTOOL_AC="${AC_LOWER}" npx --prefix packtool vitest run --config packtool/vitest.config.ts >"$LOG" 2>&1; then
  DIAG="$(grep -E 'FAIL|Error|TypeError|throw|expected' "$LOG" | head -n 1)"
  rm -f "$LOG"
  fail "$DIAG"
fi
rm -f "$LOG"

echo "CHECK ${AC_UPPER}: PASS"
exit 0
