#!/usr/bin/env bash
# Run from any directory; install dependencies first (docs/apple-silicon.md).
set -euo pipefail
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This launcher requires native Apple Silicon macOS." >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/services/image-service/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Create the image-service virtual environment first; see docs/apple-silicon.md." >&2
  exit 1
fi
cd "$ROOT/services/image-service"
export IMAGE_DEVICE="${IMAGE_DEVICE:-mps}"
exec "$PYTHON" -m uvicorn app:app --host 127.0.0.1 --port 8423
