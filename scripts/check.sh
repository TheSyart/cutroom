#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

echo "== git diff --check =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git diff --check; fi

echo "== prettier --check =="
npm run format:check

echo "== bash -n =="
while IFS= read -r script; do
  # git still lists deletions that are not staged yet; skip what is gone.
  [ -f "$script" ] || continue
  bash -n "$script"
done < <(find scripts desktop/scripts desktop/native/macos/scripts -type f -name '*.sh')

echo "== public documentation boundaries =="
node scripts/check_public_docs.mjs

# REL-04: every uses: pinned to a commit; the gates call their scripts, on macOS.
echo "== GitHub Actions pins, workflow lint, unsigned releases =="
node scripts/ci/check-action-pins.mjs
node scripts/ci/check-workflows.mjs
# REL-05: releases are unsigned; no signing secret, identity or notarization.
node scripts/ci/check-unsigned-release.mjs

echo "== core vitest =="
npm test --workspace @emperor/core

echo "== core typecheck =="
npm run typecheck --workspace @emperor/core

echo "== core eslint =="
npm run lint --workspace @emperor/core

echo "== desktop vitest =="
npm --prefix desktop run test


if [ "$(uname -s)" = "Darwin" ] && command -v swift >/dev/null 2>&1; then
  echo "== macOS helper swift test =="
  (cd desktop/native/macos && swift test)
fi

echo "== desktop test typecheck =="
npm --prefix desktop run typecheck:test

echo "== vue-tsc + tsc =="
npm --prefix desktop run typecheck

echo "== desktop eslint =="
npm --prefix desktop run lint

echo "== electron-vite build =="
npm --prefix desktop run build
