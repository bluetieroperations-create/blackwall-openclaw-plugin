#!/usr/bin/env bash
# Snapshot the agent's workspace volume so you can roll back anything it does.
# This is the ENFORCEMENT half of BLACK_WALL's reversibility score: a disposable,
# snapshot-able environment turns an "irreversible" action into a reversible one.
set -euo pipefail
cd "$(dirname "$0")"
VOL="${1:-blackwall-workspace}"
mkdir -p snapshots
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="snapshots/${VOL}-${STAMP}.tar"
podman volume export "$VOL" --output "$OUT"
echo "snapshot -> $OUT"
echo "roll back with:  ./reset.sh $VOL $OUT"
