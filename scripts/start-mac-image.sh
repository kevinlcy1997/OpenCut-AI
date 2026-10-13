#!/usr/bin/env bash
# Compatibility entry point: the native supervisor now owns all services.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/scripts/mac.sh" "${1:-start}"
