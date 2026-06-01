#!/usr/bin/env bash
# Roll the workspace volume back to a snapshot (clean restore — recreates the volume).
# Stop the agent container first (the volume can't be removed while in use).
set -euo pipefail
cd "$(dirname "$0")"
VOL="${1:-blackwall-workspace}"
SNAP="${2:?usage: ./reset.sh <volume> <snapshots/file.tar>}"
[ -f "$SNAP" ] || { echo "No such snapshot: $SNAP"; exit 1; }
podman rm -f blackwall-agent >/dev/null 2>&1 || true
podman volume rm -f "$VOL" >/dev/null 2>&1 || true
podman volume create "$VOL" >/dev/null
podman volume import "$VOL" "$SNAP"
echo "rolled back: $VOL <- $SNAP"
