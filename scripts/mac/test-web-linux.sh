#!/bin/sh
# Clean Linux frontend CI check from committed source; no local env/project mounts.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  PATH="/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:$PATH"
  export PATH
fi
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required' >&2; exit 1; }
validation_dir=$(mktemp -d "$repo_root/.mac-runtime/web-ci.XXXXXXXX")
chmod 700 "$validation_dir"
trap 'rm -f "$validation_dir/source.tar"; rmdir "$validation_dir"' EXIT HUP INT TERM
git -C "$repo_root" archive --format=tar --output="$validation_dir/source.tar" HEAD
printf 'Source commit: '
git -C "$repo_root" rev-parse HEAD
# Resolve once, then execute that exact image ID. Only official Node variants.
image_ref=${OPENCUT_CI_NODE_IMAGE:-node:22-bookworm}
case "$image_ref" in
  node:22-bookworm|node:22-bookworm-slim) ;;
  *) echo "Use an official node:22-bookworm or node:22-bookworm-slim image" >&2; exit 1 ;;
esac
image_id=$(docker image inspect "$image_ref" --format '{{.Id}}')
printf 'Linux image: %s\n' "$image_id"
docker run --rm --platform linux/amd64 --memory=6g --cpus=4 \
  --mount "type=bind,source=$validation_dir/source.tar,target=/source.tar,readonly" \
  --env DATABASE_URL=postgresql://opencut:opencut@localhost:5432/opencut \
  --env BETTER_AUTH_SECRET=supersecret --env NEXT_PUBLIC_SITE_URL=http://localhost:3000 \
  --env UPSTASH_REDIS_REST_URL=https://your-upstash-redis-url --env UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-token \
  --env NEXT_PUBLIC_MARBLE_API_URL=https://placeholder.example.com --env MARBLE_WORKSPACE_KEY=placeholder \
  --env FREESOUND_CLIENT_ID=placeholder --env FREESOUND_API_KEY=placeholder \
  --env CLOUDFLARE_ACCOUNT_ID=placeholder --env R2_ACCESS_KEY_ID=placeholder --env R2_SECRET_ACCESS_KEY=placeholder \
  --env R2_BUCKET_NAME=placeholder --env MODAL_TRANSCRIPTION_URL=https://placeholder.example.com \
  --env NEXT_TELEMETRY_DISABLED=1 "$image_id" /bin/sh -ec '
    mkdir /work
    cd /work
    tar -xf /source.tar
    npm install --global bun@1.2.18
    node --version
    bun --version
    bun install --frozen-lockfile
    cd apps/web
    bun run build
    cd /work
    bun test
  '
