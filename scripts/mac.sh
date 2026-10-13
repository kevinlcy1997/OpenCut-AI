#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export UV_CACHE_DIR="$ROOT/.mac-runtime/uv-cache"
export UV_PYTHON_INSTALL_DIR="$ROOT/.mac-runtime/python"
exec uv run --managed-python --python 3.11 --no-project python "$ROOT/scripts/mac/runtime.py" "$@"
