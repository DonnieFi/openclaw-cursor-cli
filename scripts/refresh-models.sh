#!/usr/bin/env bash
# Refresh the Cursor model catalog and OpenClaw family rules by querying
# `cursor-agent models`. Idempotent — safe to re-run any time.
#
# Output:
#   ~/.openclaw/openclaw.json                              <- models.providers.cursor-cli
#   ~/.openclaw/extensions/cursor-cli/model-rules.json     <- runtime mapping cache
#
# Usage:
#   bash scripts/refresh-models.sh             # actually refresh
#   bash scripts/refresh-models.sh --dry-run   # parse + summarize, write nothing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if ! command -v cursor-agent >/dev/null 2>&1; then
  echo "ERROR: cursor-agent not found on PATH. Install Cursor Agent CLI first." >&2
  exit 1
fi
if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw CLI not found on PATH." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH (>= 18 required)." >&2
  exit 1
fi

# Locate the 'openclaw' npm package root so we can hand the standalone Node
# process an absolute file:// URL for the plugin-sdk's run-command module.
# Node 22+ ESM does NOT honour NODE_PATH for bare specifier resolution, so we
# bypass that mechanism entirely.
#
# Resolution order (first hit wins):
#   1. $OPENCLAW_PACKAGE_ROOT  (explicit override pointing at the package dir)
#   2. `npm root -g`/openclaw   (typical npm global install)
#   3. Walk up from the openclaw binary's realpath, looking for the package.
locate_openclaw_package_root() {
  if [ -n "${OPENCLAW_PACKAGE_ROOT:-}" ] && [ -f "$OPENCLAW_PACKAGE_ROOT/package.json" ]; then
    echo "$OPENCLAW_PACKAGE_ROOT"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    local nm
    nm="$(npm root -g 2>/dev/null || true)"
    if [ -n "$nm" ] && [ -f "$nm/openclaw/package.json" ]; then
      echo "$nm/openclaw"
      return 0
    fi
  fi
  local bin_path
  bin_path="$(command -v openclaw 2>/dev/null || true)"
  if [ -n "$bin_path" ]; then
    local resolved
    if command -v readlink >/dev/null 2>&1; then
      resolved="$(readlink -f "$bin_path" 2>/dev/null || echo "$bin_path")"
    else
      resolved="$bin_path"
    fi
    local dir
    dir="$(dirname "$resolved")"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
      if [ -f "$dir/package.json" ] && grep -q '"name":[[:space:]]*"openclaw"' "$dir/package.json" 2>/dev/null; then
        echo "$dir"
        return 0
      fi
      if [ -f "$dir/node_modules/openclaw/package.json" ]; then
        echo "$dir/node_modules/openclaw"
        return 0
      fi
      dir="$(dirname "$dir")"
    done
  fi
  return 1
}

if PKG_ROOT="$(locate_openclaw_package_root)"; then
  SDK_PATH="$PKG_ROOT/dist/plugin-sdk/run-command.js"
  if [ ! -f "$SDK_PATH" ]; then
    echo "ERROR: openclaw package found at $PKG_ROOT but plugin-sdk is missing." >&2
    echo "       Expected: $SDK_PATH" >&2
    exit 1
  fi
  export OPENCLAW_RUN_COMMAND_URL="file://$SDK_PATH"
else
  echo "ERROR: cannot locate the 'openclaw' npm package on disk." >&2
  echo "       Set OPENCLAW_PACKAGE_ROOT=/path/to/openclaw and re-run." >&2
  exit 1
fi

exec node "$PROJECT_ROOT/src/refresh-models.mjs" "$@"
