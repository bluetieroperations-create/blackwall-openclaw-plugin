#!/usr/bin/env bash
# Prove the gate blocks destructive actions in the sandbox.
# Deterministic: drives the real plugin gate. Needs blackwall.env with BLACKWALL_API_KEY.
set -euo pipefail
cd "$(dirname "$0")"
[ -f blackwall.env ] || { echo "Create blackwall.env from blackwall.env.example first."; exit 1; }
podman run --rm \
  --env-file ./blackwall.env \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,size=16m \
  blackwall-sandbox:latest \
  node /home/agent/gate-demo.mjs
