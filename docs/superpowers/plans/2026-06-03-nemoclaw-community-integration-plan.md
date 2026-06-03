# BLACK_WALL × NemoClaw community integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build (but do not yet submit) an `examples/blackwall-preflight-guard/` example for a fork of `NVIDIA/nemoclaw-community` that adds BLACK_WALL's pre-action risk gate to a stock OpenClaw agent on NemoClaw and demonstrates GO/CAUTION/STOP live.

**Architecture:** Pure-POSIX-shell integration (no code to unit-test in the classic sense; "tests" are `bash -n`, the repo's SPDX header check, a live `--replay` run against the gate, and a full droplet end-to-end). Reuses the existing `blackwall-openclaw-plugin@v0.1.5` via the proven runtime-injection method (host-prep → `docker cp` → install as uid 998 → `/etc/profile.d` key → `recover`). Matches the repo's existing "OpenClaw … Example" pattern (config + policy + verification scripts, no custom-agent manifest).

**Tech Stack:** POSIX shell, `nemoclaw`/`openclaw` CLI, Docker, `curl` + `jq`, Node 22 (host-side `npm ci` only), git/`gh`.

**Spec:** `blackwall-openclaw-plugin/docs/superpowers/specs/2026-06-03-nemoclaw-community-integration-design.md`

**SPDX header** (top of every `.sh` and `.yaml`/`.yml`; checker only needs `SPDX-License-Identifier` in first 10 lines, comment style `#`):
```
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
```
> Copyright attribution is BlueTier's (contributor), license Apache-2.0 (repo requirement). If a reviewer prefers the NVIDIA copyright line, it's a one-line swap per file.

**All commits:** `git commit -s` (DCO sign-off, required).

---

## Task 0: Fork + working tree + skeleton

**Files:**
- Create fork `bluetieroperations-create/nemoclaw-community`
- Create: `examples/blackwall-preflight-guard/.gitignore`

- [ ] **Step 1: Fork and clone**
```bash
gh repo fork NVIDIA/nemoclaw-community --clone --fork-name nemoclaw-community
cd nemoclaw-community
git checkout -b blackwall-preflight-guard
mkdir -p examples/blackwall-preflight-guard/scripts examples/blackwall-preflight-guard/policy
```
Expected: fork created, branch `blackwall-preflight-guard` checked out.

- [ ] **Step 2: Write `.gitignore`** (no SPDX needed — not a checked extension)

`examples/blackwall-preflight-guard/.gitignore`:
```
.plugin-build/
.env
*.log
```

- [ ] **Step 3: Commit**
```bash
git add examples/blackwall-preflight-guard/.gitignore
git commit -s -m "chore(blackwall-preflight-guard): scaffold example dir"
```

---

## Task 1: `scripts/prepare-plugin.sh` (host-side plugin prep)

**Files:**
- Create: `examples/blackwall-preflight-guard/scripts/prepare-plugin.sh`

- [ ] **Step 1: Write the script**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# Prepare the BLACK_WALL OpenClaw plugin ON THE HOST (which has open egress + npm),
# ready to be copied into a NemoClaw sandbox. NemoClaw sandboxes block in-sandbox
# `git clone` and run npm cache-only, so the plugin must be fetched and its production
# deps installed here, then docker cp'd in by inject-plugin.sh.
set -euo pipefail

PLUGIN_REF="${BLACKWALL_PLUGIN_REF:-v0.1.5}"
PLUGIN_REPO="${BLACKWALL_PLUGIN_REPO:-https://github.com/bluetieroperations-create/blackwall-openclaw-plugin.git}"
OUT_DIR="${1:-./.plugin-build}"

command -v node >/dev/null || { echo "need Node 22+ on the host"; exit 1; }
rm -rf "$OUT_DIR"
git clone --depth 1 --branch "$PLUGIN_REF" "$PLUGIN_REPO" "$OUT_DIR"
( cd "$OUT_DIR" && npm ci --omit=peer --omit=dev --no-audit --no-fund )
# openclaw's installer rejects hardlinked files; npm may hardlink binaries from its cache.
find "$OUT_DIR" -type f -links +1 -exec sh -c 'cp -p "$1" "$1.u" && mv -f "$1.u" "$1"' _ {} \;
echo "prepared blackwall-openclaw-plugin@$PLUGIN_REF -> $OUT_DIR"
```

- [ ] **Step 2: Syntax check**
```bash
bash -n examples/blackwall-preflight-guard/scripts/prepare-plugin.sh
```
Expected: no output, exit 0.

- [ ] **Step 3: Commit**
```bash
chmod +x examples/blackwall-preflight-guard/scripts/prepare-plugin.sh
git add examples/blackwall-preflight-guard/scripts/prepare-plugin.sh
git commit -s -m "feat(blackwall-preflight-guard): host-side plugin prep script"
```

---

## Task 2: `scripts/inject-plugin.sh` (runtime injection as uid 998)

**Files:**
- Create: `examples/blackwall-preflight-guard/scripts/inject-plugin.sh`

- [ ] **Step 1: Write the script**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# Inject the prepared plugin into a running, ONBOARDED NemoClaw sandbox as the sandbox
# user (uid 998). This is the only non-destructive path: a build-time `openclaw plugins
# install` in a Dockerfile pre-empts `nemoclaw onboard`'s gateway/auth/inference config
# and the gateway never starts. Installing as uid 998 MERGES into the onboard config.
# The API key is delivered via /etc/profile.d because NemoClaw does NOT propagate Docker
# ENV into the spawned agent.
set -euo pipefail

SANDBOX="${1:?usage: inject-plugin.sh <sandbox-name> [plugin-build-dir]}"
BUILD_DIR="${2:-./.plugin-build}"
: "${BLACKWALL_API_KEY:?set BLACKWALL_API_KEY (free key: https://blackwalltier.com/dashboard/keys)}"
MODE="${BLACKWALL_MODE:-enforce}"
RUNTIME="${CONTAINER_RUNTIME:-docker}"   # docker or podman

CID="$("$RUNTIME" ps --filter "name=openshell-${SANDBOX}" --format '{{.ID}}' | head -1)"
[ -n "$CID" ] || { echo "no running container for sandbox '$SANDBOX' (is it onboarded?)"; exit 1; }

"$RUNTIME" cp "$BUILD_DIR" "$CID:/tmp/bwplugin"
"$RUNTIME" exec -u root "$CID" chown -R 998:998 /tmp/bwplugin
"$RUNTIME" exec -u 998 "$CID" bash -lc 'export HOME=/sandbox; openclaw plugins install /tmp/bwplugin --force'
# Key + mode -> /etc/profile.d (passed as positional args so the literal key is not interpolated into the command string).
"$RUNTIME" exec -u root "$CID" sh -c \
  'umask 077; printf "export BLACKWALL_API_KEY=%s\nexport BLACKWALL_MODE=%s\n" "$0" "$1" > /etc/profile.d/blackwall.sh; chmod a+r /etc/profile.d/blackwall.sh' \
  "$BLACKWALL_API_KEY" "$MODE"
nemoclaw "$SANDBOX" recover
echo "injected blackwall-openclaw-plugin into '$SANDBOX' (mode=$MODE)"
```

- [ ] **Step 2: Syntax check** — `bash -n examples/blackwall-preflight-guard/scripts/inject-plugin.sh` → exit 0.

- [ ] **Step 3: Commit**
```bash
chmod +x examples/blackwall-preflight-guard/scripts/inject-plugin.sh
git add examples/blackwall-preflight-guard/scripts/inject-plugin.sh
git commit -s -m "feat(blackwall-preflight-guard): runtime inject-as-uid-998 script"
```

---

## Task 3: `policy/blackwall-egress.yaml`

**Files:**
- Create: `examples/blackwall-preflight-guard/policy/blackwall-egress.yaml`

- [ ] **Step 1: Write the policy**
```yaml
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# Only needed under a stricter-than-balanced egress tier. On NemoClaw's default/balanced
# policy, blackwalltier.com is already reachable (validated 2026-06-02).
preset:
  name: blackwall-egress
network_policies:
  blackwall:
    name: blackwall
    allow:
      - host: blackwalltier.com
```

- [ ] **Step 2: Commit**
```bash
git add examples/blackwall-preflight-guard/policy/blackwall-egress.yaml
git commit -s -m "feat(blackwall-preflight-guard): egress policy preset"
```

---

## Task 4: `setup.sh` + `teardown.sh`

**Files:**
- Create: `examples/blackwall-preflight-guard/setup.sh`
- Create: `examples/blackwall-preflight-guard/teardown.sh`

- [ ] **Step 1: Write `setup.sh`**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# One-shot: onboard a vanilla OpenClaw sandbox, inject BLACK_WALL, (optionally) apply egress.
set -euo pipefail
SANDBOX="${SANDBOX_NAME:-blackwall-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${BLACKWALL_API_KEY:?set BLACKWALL_API_KEY — free key at https://blackwalltier.com/dashboard/keys}"

echo "[1/3] onboard '$SANDBOX' (vanilla OpenClaw sandbox)"
nemoclaw onboard --name "$SANDBOX" --no-gpu ${NEMOCLAW_ONBOARD_ARGS:-}

echo "[2/3] prepare plugin on host"
"$HERE/scripts/prepare-plugin.sh" "$HERE/.plugin-build"

echo "[3/3] inject plugin (uid 998) + API key"
"$HERE/scripts/inject-plugin.sh" "$SANDBOX" "$HERE/.plugin-build"

# Stricter-than-balanced egress only:
# nemoclaw "$SANDBOX" policy-add --from-file "$HERE/policy/blackwall-egress.yaml" --yes

echo
echo "Ready. Verify the plugin loaded:"
echo "  nemoclaw $SANDBOX exec -- openclaw plugins inspect blackwall-openclaw-plugin"
echo "Run the demo:  ./demo.sh"
```

- [ ] **Step 2: Write `teardown.sh`**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SANDBOX="${SANDBOX_NAME:-blackwall-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
nemoclaw "$SANDBOX" destroy --yes || true
rm -rf "$HERE/.plugin-build"
echo "destroyed '$SANDBOX' and cleaned build artifacts"
```

- [ ] **Step 3: Syntax check both** — `bash -n setup.sh teardown.sh` → exit 0.

- [ ] **Step 4: Commit**
```bash
chmod +x examples/blackwall-preflight-guard/setup.sh examples/blackwall-preflight-guard/teardown.sh
git add examples/blackwall-preflight-guard/setup.sh examples/blackwall-preflight-guard/teardown.sh
git commit -s -m "feat(blackwall-preflight-guard): setup + teardown orchestration"
```

---

## Task 5: `demo.sh --replay` (deterministic, no sandbox)

**Files:**
- Create: `examples/blackwall-preflight-guard/demo.sh`

The `--replay` path sends the three crafted tool-call payloads straight to `forecast()` — the exact action/inputs the plugin's `before_tool_call` hook would send — so a reviewer sees GO/CAUTION/STOP in ~30s with only a BLACK_WALL key. (Live mode added in Task 6.)

- [ ] **Step 1: Write `demo.sh` (replay path first)**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# Demonstrate the BLACK_WALL gate's GO / CAUTION / STOP verdicts.
#   ./demo.sh            live: drive the onboarded OpenClaw agent (needs a sandbox)
#   ./demo.sh --replay   deterministic: POST the 3 crafted tool calls to forecast()
#                        (needs only BLACKWALL_API_KEY — no NemoClaw, no Docker)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BLACKWALL_BASE_URL:-https://blackwalltier.com}"

forecast() { # $1=action $2=inputs-json $3=context-json
  curl -s --max-time 30 -X POST "$BASE/api/v1/forecast" \
    -H "Authorization: Bearer ${BLACKWALL_API_KEY:?set BLACKWALL_API_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"action\":\"$1\",\"inputs\":$2,\"context\":$3}"
}

replay() {
  command -v jq >/dev/null || { echo "need jq for --replay"; exit 1; }
  printf '%-8s | %-7s | %-5s | %s\n' STEP VERDICT RISK RECEIPT
  printf '%-8s-+-%-7s-+-%-5s-+-%s\n' "--------" "-------" "-----" "------------------------------------"
  run() { # $1=label $2=action $3=inputs $4=context
    local r; r="$(forecast "$2" "$3" "$4")"
    printf '%-8s | %-7s | %-5s | %s\n' \
      "$1" "$(echo "$r" | jq -r .recommendation)" "$(echo "$r" | jq -r .risk_score)" \
      "$(echo "$r" | jq -r .receipt.id)"
  }
  run GO    read         '{"path":"/sandbox","cmd":"du -sh *"}'                 '{"agent_role":"devops agent","environment":"production"}'
  run CAUTION file_write  '{"path":"/sandbox/app.log","cmd":"truncate -s0 /sandbox/app.log","note":"recoverable: rotates a log"}' '{"agent_role":"devops agent","environment":"production"}'
  run STOP  delete_files '{"path":"/sandbox/data","cmd":"rm -rf /sandbox/data","recursive":true}' '{"agent_role":"devops agent","environment":"production"}'
  echo
  echo "Verify any receipt: $BASE/api/v1/receipts/verify  (public key: $BASE/.well-known/blackwall-signing-keys.json)"
}

case "${1:-}" in
  --replay) replay ;;
  *) "$HERE/scripts/drive-live.sh" ;;   # live mode (Task 6)
esac
```

- [ ] **Step 2: Syntax check** — `bash -n demo.sh` → exit 0.

- [ ] **Step 3: Run `--replay` against the live gate (real verification)**
```bash
export BLACKWALL_API_KEY=bw_live_…   # a real test/live key
cd examples/blackwall-preflight-guard && ./demo.sh --replay
```
Expected: a 3-row table — `GO` row recommendation GO, `STOP` row recommendation STOP, `CAUTION` row recommendation CAUTION (the middle is the one to confirm; see Task 8 droplet note if it lands GO/STOP instead — adjust the `file_write` inputs until it reliably reads CAUTION, e.g. overwrite a config vs. a log).

- [ ] **Step 4: Commit**
```bash
chmod +x examples/blackwall-preflight-guard/demo.sh
git add examples/blackwall-preflight-guard/demo.sh
git commit -s -m "feat(blackwall-preflight-guard): demo.sh --replay (no-sandbox gate demo)"
```

---

## Task 6: `scripts/drive-live.sh` (live agent dispatch)

**Files:**
- Create: `examples/blackwall-preflight-guard/scripts/drive-live.sh`

Drives the onboarded OpenClaw agent to emit the three tool calls; the plugin's hook gates each on the command content. **The exact one-shot drive command is confirmed/adjusted during droplet validation (Task 8)** — this is the concrete first implementation.

- [ ] **Step 1: Write the script**
```bash
#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
# SPDX-License-Identifier: Apache-2.0
#
# Live demo: instruct the onboarded OpenClaw agent to attempt three actions; BLACK_WALL
# gates each before it runs. The agent emits the instructed command; the GATE decides on
# the command content (deterministic for a given command). Prints the gate's verdict lines.
set -euo pipefail
SANDBOX="${SANDBOX_NAME:-blackwall-demo}"

ask() { # $1=label $2=instruction
  echo "=== $1: $2 ==="
  # One-shot, non-interactive agent turn. (Drive mechanism confirmed on droplet — Task 8.)
  nemoclaw "$SANDBOX" exec -- bash -lc "openclaw run --no-interactive \"$2\"" 2>&1 \
    | grep -iE '\[blackwall\]|GO|CAUTION|STOP|risk|forecast|receipt' || true
  echo
}

ask GO      "Report disk usage of /sandbox with: du -sh /sandbox/*"
ask CAUTION "Rotate the app log by truncating /sandbox/app.log to zero bytes"
ask STOP    "Free space by deleting the directory /sandbox/data with rm -rf"

echo "Tip: tail the gate log live with:  nemoclaw $SANDBOX logs --follow | grep blackwall"
```

- [ ] **Step 2: Syntax check** — `bash -n scripts/drive-live.sh` → exit 0.

- [ ] **Step 3: Commit**
```bash
chmod +x examples/blackwall-preflight-guard/scripts/drive-live.sh
git add examples/blackwall-preflight-guard/scripts/drive-live.sh
git commit -s -m "feat(blackwall-preflight-guard): live agent-dispatch demo driver"
```

---

## Task 7: `.env.example` + `README.md`

**Files:**
- Create: `examples/blackwall-preflight-guard/.env.example`
- Create: `examples/blackwall-preflight-guard/README.md`

- [ ] **Step 1: Write `.env.example`** (no SPDX — not a checked extension)
```
# Free key: https://blackwalltier.com/dashboard/keys  (~100 forecasts/month free)
BLACKWALL_API_KEY=
# observe = log verdicts only; enforce = block STOP, gate CAUTION
BLACKWALL_MODE=enforce
# Sandbox name (optional)
SANDBOX_NAME=blackwall-demo
```

- [ ] **Step 2: Write `README.md`** — sections, in order:
  1. **Title + one-liner:** "Pre-action risk gate for OpenClaw agents on NemoClaw."
  2. **Defense-in-depth framing:** NemoClaw already sandboxes the agent and constrains egress; BLACK_WALL adds a third, independent layer — it checks *what the agent is about to do* and blocks destructive/irreversible/exfil actions *before they run*, independent of the model's own judgment. Cite that this follows the repo's existing "OpenClaw … Example" pattern (reference config + policy + verification scripts; OpenClaw is NemoClaw's default agent, so no custom-agent manifest).
  3. **What you'll see:** the GO/CAUTION/STOP table (devops scenario).
  4. **Quick look (30s, no sandbox):** `cp .env.example .env`, set `BLACKWALL_API_KEY`, `./demo.sh --replay`. Show sample output.
  5. **Full demo on NemoClaw:** prerequisites (NemoClaw onboarded once, Docker/podman, an `nvapi-` inference key, a free BLACK_WALL key); `./setup.sh`; `./demo.sh`; `./teardown.sh`. Note runtime-injection rationale in one line + link to `https://github.com/bluetieroperations-create/blackwall-openclaw-plugin/blob/v0.1.5/docs/nemoclaw.md`.
  6. **Signed receipts:** every verdict returns an Ed25519-signed receipt — a tamper-evident, offline-verifiable record of what was about to happen and why it was allowed/blocked. Verify at `…/api/v1/receipts/verify`.
  7. **How it works:** `before_tool_call` → `forecast()` → block STOP / prompt CAUTION; config env table (`BLACKWALL_API_KEY`, `BLACKWALL_MODE`, `BLACKWALL_FAIL_CLOSED`).
  8. **Cost/keys note:** the demo makes ~6 `forecast()` calls (free tier covers it); links to the key page (funnel).
  9. **Proof:** link to `PROOF.md` (captured real run).

  Use this exact PROOF table shape so Task 8 can drop numbers in:
```markdown
| Step | Instruction | Tool call | Verdict |
|---|---|---|---|
| GO | report disk usage | `du -sh /sandbox/*` | ✅ GO — runs |
| CAUTION | rotate app log | `truncate -s0 /sandbox/app.log` | ⚠️ CAUTION — approval prompt |
| STOP | delete data dir | `rm -rf /sandbox/data` | 🛑 STOP — blocked before exec |
```

- [ ] **Step 3: Commit**
```bash
git add examples/blackwall-preflight-guard/.env.example examples/blackwall-preflight-guard/README.md
git commit -s -m "docs(blackwall-preflight-guard): README + .env.example"
```

---

## Task 8: Droplet end-to-end validation → `PROOF.md`

**Files:**
- Create: `examples/blackwall-preflight-guard/PROOF.md`
- Possibly modify: `scripts/drive-live.sh`, `demo.sh` (CAUTION tuning), per real behavior

> Interactive: **Sam spins a DigitalOcean droplet**; Claude drives via SSH (same pattern as 2026-06-03). ~$0.30–0.60, DO credit.

- [ ] **Step 1:** On the droplet: install Docker + binutils + NemoClaw; set an `nvapi-` key at `/root/.nvkey`; copy the example dir up.
- [ ] **Step 2:** `export BLACKWALL_API_KEY=…; ./setup.sh` end-to-end. Confirm: `openclaw plugins inspect blackwall-openclaw-plugin` → `Status: loaded`, gateway healthy, `openclaw config validate` clean.
- [ ] **Step 3:** Run `./demo.sh` (live). **Resolve open items:** (a) confirm/replace the exact `openclaw run --no-interactive` drive command with whatever actually produces a one-shot gated turn; (b) tune the CAUTION scenario inputs until the middle step reliably returns CAUTION (not GO/STOP). Update `drive-live.sh`/`demo.sh` accordingly and re-run.
- [ ] **Step 4:** Run `./demo.sh --replay`; capture the 3-row verdict table + receipt IDs.
- [ ] **Step 5:** Write `PROOF.md` — real captured output (live + replay), the verdict table (matching README), receipt IDs + verify URL, the environment (NemoClaw/OpenClaw versions, date). Add SPDX header? No (`.md` not checked) — but include a one-line provenance.
- [ ] **Step 6:** Run the repo's local checks from the fork root:
```bash
python scripts/check_license_headers.py --check
git diff --check
bash -n examples/blackwall-preflight-guard/*.sh examples/blackwall-preflight-guard/scripts/*.sh
```
Expected: all pass (no missing headers, no whitespace errors, no syntax errors).
- [ ] **Step 7:** Destroy the droplet (confirm with Sam). Then commit any tuning + PROOF.md:
```bash
git add examples/blackwall-preflight-guard/PROOF.md examples/blackwall-preflight-guard/demo.sh examples/blackwall-preflight-guard/scripts/drive-live.sh
git commit -s -m "test(blackwall-preflight-guard): real NemoClaw run + captured proof"
```

---

## Task 9: Register in the root index + final hygiene

**Files:**
- Modify: `README.md` (root "Reference Examples" table)

- [ ] **Step 1: Add a row to the root README table** (after the existing rows, ~line 23):
```markdown
| BLACK_WALL Preflight Guard | Adds a pre-action risk gate to a stock OpenClaw agent: every tool call is scored by the BLACK_WALL forecast API before it runs, blocking destructive/irreversible actions with an Ed25519-signed receipt. Defense-in-depth alongside the sandbox + egress controls. | [Guide](examples/blackwall-preflight-guard/README.md) |
```

- [ ] **Step 2: Final local checks** (from fork root) — all green:
```bash
python scripts/check_license_headers.py --check && git diff --check && echo OK
```

- [ ] **Step 3: Commit**
```bash
git add README.md
git commit -s -m "docs: register BLACK_WALL Preflight Guard in Reference Examples"
```

---

## Task 10: Submit — GATED on the NVIDIA reviewer's cue

> **Do NOT open the PR yet.** Build is complete and pushed to the fork branch; the PR waits for `wscurran`'s steer on PR #4692 (he offered nothing yet but we floated community there). **Timebox: if no steer in ~3–5 days, submit anyway** — the example is our chosen strategy regardless.

- [ ] **Step 1: Push the branch to the fork** (safe — a branch on our fork, not a PR):
```bash
git push -u origin blackwall-preflight-guard
```
- [ ] **Step 2: Hold.** Watch PR #4692 for wscurran's reply (the existing watcher routine). On "yes, community" → proceed. On "fix the blueprint" → re-evaluate (example still stands). On silence past the timebox → proceed.
- [ ] **Step 3: Open the PR** (when cued) — title `Add BLACK_WALL Preflight Guard example (OpenClaw pre-action risk gate)`; body: what it demonstrates, the `--replay` quick-look, the captured proof, defense-in-depth framing, DCO note. Reference the #4692 conversation if wscurran redirected us here.
```bash
gh pr create --repo NVIDIA/nemoclaw-community --base main \
  --head bluetieroperations-create:blackwall-preflight-guard \
  --title "Add BLACK_WALL Preflight Guard example (OpenClaw pre-action risk gate)" \
  --body-file PR_BODY.md
```

---

## Self-review notes
- **Spec coverage:** structure (T0–4,7,9), setup/inject/key/recover (T1–4), live + replay demo (T5–6), positioning/receipts/funnel (T7), droplet validation + PROOF + local checks (T8), index registration (T9), build-now/hold-PR sequencing + timebox (T10). Plugin pinned to `v0.1.5` (T1). SPDX headers + DCO throughout.
- **Open items** are confined to Task 8 (drive command + CAUTION tuning) with concrete first implementations to validate, not blanks.
- **Non-goals honored:** no manifest, no Python port, no build-time Dockerfile, no crypto.
