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

exec node "$PROJECT_ROOT/src/refresh-models.mjs" "$@"
