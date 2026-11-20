#!/usr/bin/env bash
# The macOS PR gate (REL-04, MAIN-29); ci.yml runs it, and so can you:
#
#   scripts/ci/pr-gate.sh                make check, Electron editing, package:verify, unsealed probes
#   scripts/ci/pr-gate.sh --build-only   desktop build instead of make check (Intel job)
#   scripts/ci/pr-gate.sh --app <.app>   only the packaged smoke, on a build you have
#   scripts/ci/pr-gate.sh --dry-run      print the steps, run nothing
#
# package:verify checks the sealed app, its Electron fuses, its dictation
# helper, and the editor's home and project bridge in an isolated profile.
# The negative probes run on disposable copies of the app.
set -euo pipefail

usage() {
  echo "usage: scripts/ci/pr-gate.sh [--build-only] [--app <Cutroom.app>] [--dry-run]" >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode=full
app=""
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only) mode=build ;;
    --app)
      [ "$#" -ge 2 ] || usage
      app="$2"
      shift
      ;;
    --dry-run) dry_run=1 ;;
    *) usage ;;
  esac
  shift
done

step() {
  echo "pr-gate: $*"
  if [ "$dry_run" = 0 ]; then
    (cd "$ROOT" && "$@")
  fi
}

if [ -n "$app" ]; then
  app="${app%/}"
  step node desktop/scripts/run-packaged-smoke.cjs --app "$app/Contents/MacOS/Cutroom"
  exit 0
fi

if [ "$mode" = full ]; then
  step ./scripts/check.sh
  step node desktop/scripts/e2e-cu.mjs --mode=editing
else
  step npm --prefix desktop run build
fi
step npm --prefix desktop run package:verify
step node scripts/ci/gate-negative-probe.mjs
