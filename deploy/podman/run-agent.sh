#!/usr/bin/env bash
# Full OpenClaw agent, gated by BLACK_WALL, in a hardened rootless container with a
# persistent, snapshot-able workspace. Needs blackwall.env (BLACKWALL_API_KEY + your model key).
#
# Hardening: drops all Linux caps, blocks privilege escalation, maps the container user to
# YOU (rootless), and confines writes to a named volume you can snapshot/roll back.
set -euo pipefail
cd "$(dirname "$0")"
[ -f blackwall.env ] || { echo "Create blackwall.env from blackwall.env.example first."; exit 1; }
podman volume create blackwall-workspace >/dev/null 2>&1 || true
podman run -it --rm \
  --name blackwall-agent \
  --env-file ./blackwall.env \
  --userns=keep-id \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  -v blackwall-workspace:/home/agent/workspace:rw \
  blackwall-sandbox:latest \
  bash
# ── Inside the container, start the agent with YOUR openclaw version's run command. ──
# (Left as a shell drop-in because the exact subcommand varies by openclaw build.)
#   openclaw --help          # find the agent-run subcommand
#   openclaw agent main      # <- verify the exact subcommand/flags for your build
# Every tool call then routes through before_tool_call -> BLACK_WALL -> verdict.
# Try a destructive prompt ("delete everything in my workspace") and watch it get blocked.
