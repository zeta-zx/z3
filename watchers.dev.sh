#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

mkdir -p schema

set -a
set +a

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down watchers..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  echo "Cleanup done."
}

trap cleanup EXIT INT TERM

(
  ephaptic generate backend.src.app:ephaptic -o ./frontend/src/lib/schema.d.ts --lang ts --watch
) &
PIDS+=($!)

sleep 365d