#!/usr/bin/env bash
# Acceptance-check driver for issue #77 (Storyline extractor), one AC per run.
#
# Usage (from repo root):
#   bash packtool/scripts/acceptance-check.sh <AC-ID>     # AC1 .. AC7
#
# Behavior:
#   1. Base-tree sentinel: if packtool/storyline/decode.ts does not exist,
#      print "CHECK <AC-ID>: FAIL packtool/storyline not implemented (base tree)"
#      and exit 1 (this line is the --expect match for every check on the
#      pre-implementation tree).
#   2. Install deps when missing (npm ci --prefix packtool).
#   3. Rebuild before every run when stale (missing dist/cli.js or any
#      packtool/storyline/**/*.ts newer than it) — staleness fakes green.
#   4. Run exactly the one AC's vitest file (PACKTOOL_AC selects it in
#      packtool/vitest.config.ts); print "CHECK <AC-ID>: PASS" / ": FAIL".

set -u

AC_ID="${1:-}"
case "$AC_ID" in
  [Aa][Cc][1-7]) ;;
  *)
    echo "usage: bash packtool/scripts/acceptance-check.sh <AC1|AC2|AC3|AC4|AC5|AC6|AC7>" >&2
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

fail() {
  echo "CHECK ${AC_UPPER}: FAIL"
  exit 1
}

# 2. Dependencies (package-lock.json is committed).
if [ ! -d packtool/node_modules ]; then
  npm ci --prefix packtool || fail
fi

# 3. Rebuild when stale so a stale dist/ can never fake green.
STALE_SRC="$(find packtool/storyline -name '*.ts' -type f -newer packtool/dist/cli.js -print -quit 2>/dev/null)"
if [ ! -f packtool/dist/cli.js ] || [ -n "${STALE_SRC}" ]; then
  npm run build --prefix packtool || fail
fi

# 4. Run exactly one AC's test file. The root is pinned to the packtool dir in
#    vitest.config.ts and PACKTOOL_AC selects the single include, so this works
#    with cwd = repo root.
command -v npx >/dev/null 2>&1 || fail
PACKTOOL_AC="${AC_LOWER}" npx --prefix packtool vitest run --config packtool/vitest.config.ts || fail

echo "CHECK ${AC_UPPER}: PASS"
exit 0
