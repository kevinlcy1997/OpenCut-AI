#!/bin/sh
# CI-equivalent native logic tests; no models, services or project data are mounted.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
  export PATH
fi
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required' >&2; exit 1; }
docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$repo_root/scripts/mac,target=/work/scripts/mac,readonly" \
  --mount "type=bind,source=$repo_root/services/media-service/app.py,target=/work/services/media-service/app.py,readonly" \
  --mount "type=bind,source=$repo_root/services/media-service/test_media.py,target=/work/services/media-service/test_media.py,readonly" \
  --workdir /work --env PYTHONPATH=scripts/mac \
  python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce \
  python -c 'import os,platform,subprocess,sys; print("CI platform:",platform.platform(),platform.machine(),sys.version,flush=True); subprocess.run([sys.executable,"-m","pip","install","--disable-pip-version-check","-r","scripts/mac/locks/tests.lock"],check=True); subprocess.run([sys.executable,"-m","unittest","scripts/mac/test_runtime.py","scripts/mac/test_coordinator.py","scripts/mac/test_local_access.py","scripts/mac/test_validate_audio.py","scripts/mac/test_validate_speed_ramp.py","scripts/mac/test_soak.py"],check=True); subprocess.run([sys.executable,"-m","unittest","services/media-service/test_media.py"],check=True,env=dict(os.environ,PYTHONPATH="services/media-service"))'
