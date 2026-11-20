#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 防止编辑器终端把桌面应用强制成普通 Node 进程。
unset ELECTRON_RUN_AS_NODE

if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  printf '%s\n' '需要 Node.js 22 或更新版本。' >&2
  exit 1
fi

if [ ! -x node_modules/.bin/tsc ]; then
  npm ci --no-audit --no-fund
fi
if [ ! -x desktop/node_modules/.bin/electron-vite ]; then
  npm --prefix desktop ci --no-audit --no-fund
fi
cd desktop
if [ ! -x 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' ]; then
  node node_modules/electron/install.js
fi
npm run build
exec ./node_modules/.bin/electron .
