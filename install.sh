#!/usr/bin/env bash
set -euo pipefail
# Resolve the script dir in a subshell — do not cd the caller cwd.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js ≥ 22.19，然后重新运行 ./install.sh" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/scripts/install-grok.mjs" "$@"
