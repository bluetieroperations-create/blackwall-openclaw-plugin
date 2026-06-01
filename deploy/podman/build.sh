#!/usr/bin/env bash
# Build the rootless BLACK_WALL × OpenClaw sandbox image.
set -euo pipefail
cd "$(dirname "$0")"
podman build -t blackwall-sandbox:latest \
  --build-arg BLACKWALL_PLUGIN_REF="${BLACKWALL_PLUGIN_REF:-main}" \
  --build-arg OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.4.27}" \
  -f Containerfile .
echo "built: blackwall-sandbox:latest"
