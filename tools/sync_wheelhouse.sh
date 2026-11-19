#!/usr/bin/env bash
# Bring the local wheelhouse/ and plan.json in step with requirements/, the
# way CI builds them (.github/workflows/pages.yml, job "wheelhouse").
#
#   tools/sync_wheelhouse.sh
#
# CI builds the wheelhouse from nothing on every push. Locally it used to be
# topped up by hand, so old wheels stayed next to new ones and packages
# added to requirements/ were missing (a local build then lacked e.g. the
# Whisper STT plugin). This builds a fresh wheelhouse in wheelhouse.new/,
# and only when that worked swaps it in; the old one is kept as
# wheelhouse.old/ until the next run. pip's cache makes a re-run quick.
#
#   EMKAY_PYTHON  the CPython to build with (default: .venv-build/bin/python,
#                 else python3.14 – the version Pyodide 314 is built from)
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${EMKAY_PYTHON:-}"
if [[ -z "$PY" ]]; then
  if [[ -x .venv-build/bin/python ]]; then PY=.venv-build/bin/python
  else PY=$(command -v python3.14 || true); fi
fi
[[ -n "$PY" ]] || { echo "No Python 3.14 found: make .venv-build or set EMKAY_PYTHON" >&2; exit 1; }
LOG=$(mktemp -t emkay-wheelhouse.XXXXXX.log)
step() { printf '  %s… ' "$1"; }
ok() { printf 'ok%s\n' "${1:+ ($1)}"; }
fail() { printf 'failed\n\nWhat pip said (%s):\n' "$LOG" >&2; tail -25 "$LOG" >&2; exit 1; }

echo "Emkay wheelhouse, with $("$PY" --version) ($PY)"
rm -rf wheelhouse.new

step "Wheels for requirements/browser.txt (alpha channel)"
"$PY" -m pip wheel --pre -q -w wheelhouse.new -r requirements/browser.txt >>"$LOG" 2>&1 || fail
ok

step "Wheels installed without their dependencies"
"$PY" -m pip wheel --pre --no-deps -q -w wheelhouse.new \
  -r requirements/browser-nodeps.txt -r requirements/browser-emscripten.txt >>"$LOG" 2>&1 || fail
ok "$(ls wheelhouse.new | wc -l) wheels"

step "What changed"
old=$( [[ -d wheelhouse ]] && ls wheelhouse | sort || true)
new=$(ls wheelhouse.new | sort)
added=$(comm -13 <(echo "$old") <(echo "$new"))
removed=$(comm -23 <(echo "$old") <(echo "$new"))
ok "$(grep -c . <<<"$added" || true) new, $(grep -c . <<<"$removed" || true) gone"
[[ -n "$added" ]] && sed 's/^/      + /' <<<"$added"
[[ -n "$removed" ]] && sed 's/^/      - /' <<<"$removed"

step "Swapping it in (the old one is wheelhouse.old/)"
rm -rf wheelhouse.old
[[ -d wheelhouse ]] && mv wheelhouse wheelhouse.old
mv wheelhouse.new wheelhouse
ok

step "plan.json"
"$PY" tools/wheelplan.py wheelhouse node_modules/pyodide/pyodide-lock.json > plan.json 2>>"$LOG" || fail
ok

rm -f "$LOG"
echo "Done. Build the site with tools/build_site.py as in README.md."
