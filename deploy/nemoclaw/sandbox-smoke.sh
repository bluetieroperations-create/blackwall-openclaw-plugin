#!/usr/bin/env bash
# Level A blueprint proof: run the official sandbox smoke INSIDE NVIDIA's real
# sandbox-base image. Reuses the key file from the podman demo (so you don't re-enter it).
#
#   ./sandbox-smoke.sh                       # uses ../podman/blackwall.env
#   ./sandbox-smoke.sh /path/to/env          # or a specific env file with BLACKWALL_API_KEY
set -euo pipefail
cd "$(dirname "$0")"
ENVFILE="${1:-../podman/blackwall.env}"
[ -f "$ENVFILE" ] || { echo "No env file at $ENVFILE (needs BLACKWALL_API_KEY). Run the podman demo's key step first, or pass a path."; exit 1; }

echo "== building plugin into NVIDIA's real NemoClaw sandbox-base image =="
podman build -t blackwall-nemoclaw -f Containerfile.sandbox .

echo "== running the official sandbox smoke INSIDE the sandbox-base image (live BLACK_WALL) =="
podman run --rm --env-file "$ENVFILE" \
  blackwall-nemoclaw \
  node /sandbox/.openclaw/extensions/blackwall-openclaw-plugin/scripts/sandbox-smoke.mjs
