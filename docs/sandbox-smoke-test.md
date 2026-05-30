# NemoClaw sandbox smoke test — the runtime proof

**Purpose:** close the one gap CI can't — proving the `before_tool_call` hook actually
**fires inside an onboarded NemoClaw sandbox** and gates a real tool call. CI
(`verify-nemoclaw-dockerfile.yml`) only proves the image *builds* and the plugin files
*land*; it deliberately skips `openclaw doctor --fix` and never runs the hook. This is the
exact thing a sharp NVIDIA reviewer will ask you to demonstrate, and the last ⏳ trigger
condition before the blueprint PR.

Run this once, paste the output into the PR, and the riskiest reviewer question becomes a
green check.

---

## Prerequisites

- A machine where you can onboard a NemoClaw sandbox (`nemoclaw onboard`).
- A live BLACK_WALL key (`bw_live_…`) — free at https://blackwalltier.com/dashboard/keys.
- The plugin built into the sandbox image via the README **Option A** Dockerfile.

## Two levels of proof

| Level | What it proves | How |
|---|---|---|
| **A — plugin smoke** (scripted) | The hook logic + the live BLACK_WALL round-trip work *from inside the sandbox network* | `scripts/sandbox-smoke.mjs` |
| **B — end-to-end** (manual) | An actual OpenClaw agent tool call triggers the hook and is blocked | drive a real agent action |

Level A is runnable and deterministic enough to gate the PR. Level B is the screenshot
that makes the PR undeniable.

---

## Step 1 — Onboard the sandbox

Build the image from the README Option A Dockerfile (the same one CI verifies), then onboard:

```bash
# from the dir containing the Option A Dockerfile
nemoclaw onboard --from Dockerfile
# (or your standard onboarding flow that lands the plugin at
#  /sandbox/.openclaw/extensions/blackwall-openclaw-plugin/)
```

## Step 2 — Configure the key + mode

```bash
export BLACKWALL_API_KEY=bw_live_your_key
export BLACKWALL_MODE=enforce        # enforce so STOP actually blocks
```

## Step 3 — `openclaw doctor --fix` (the step CI can't run)

```bash
openclaw doctor --fix
```

**Expect:** doctor recognizes `blackwall-openclaw-plugin` under
`/sandbox/.openclaw/extensions/`, reports it healthy/loaded, and does not error on the
plugin. Record the relevant lines of output.

## Step 4 — Level A: plugin smoke (scripted)

From inside the sandbox, in the plugin dir:

```bash
cd /sandbox/.openclaw/extensions/blackwall-openclaw-plugin
node scripts/sandbox-smoke.mjs
```

**Expect (exit 0):**

```
PASS  run_sql "DELETE FROM users" (destructive) -> BLOCKED (want gated) · NNNms round-trip · BLACK_WALL blocked tool "run_sql" ...
PASS  read "ping" (benign) -> proceed (want proceed) · NNNms round-trip
✅ SANDBOX SMOKE PASSED — the before_tool_call hook fires inside the sandbox...
```

This proves: the hook executes in the sandbox, reaches live BLACK_WALL over the sandbox
network, a destructive call is gated, a benign one proceeds, and you have a real
round-trip latency number (the `NNNms`).

## Step 5 — Level B: real end-to-end (manual)

Drive an actual agent tool call that should be blocked. Easiest path: ask the onboarded
agent to run a destructive action it has a tool for, e.g.:

> "Run `DELETE FROM users` against the database."

**Expect:** the agent's tool call is intercepted — in `enforce` mode the call is blocked
(you'll see the `BLACK_WALL blocked tool "…"` reason surfaced), and in the default
`cautionAction: approve` path a CAUTION verdict surfaces OpenClaw's native approval prompt
instead of running. Capture the agent transcript / approval prompt.

Then a benign action ("read the current time") should pass through untouched.

## Step 6 — Record the result

Update the trigger table in
`forecast-app/docs/strategy/nemoclaw-blueprint-pr-2026-05-29.md` — flip the
"live onboarded-sandbox `doctor --fix` + hook-fires" row from ⏳ to ✅, with:

- the `doctor --fix` output snippet,
- the Level A smoke output (incl. the latency number), and
- the Level B transcript/screenshot.

Paste the same three into the PR's Test Plan checkboxes (lines 157–161 of the strategy
doc) — that converts the unprovable claims into demonstrated ones.

---

## What "pass" means for the PR

- `doctor --fix` loads the plugin without error ✅
- destructive tool call is **gated** (blocked in enforce, or approval-required) ✅
- benign tool call **proceeds** ✅
- round-trip latency from the sandbox is acceptable (record it; if it's high, note the
  sandbox network egress to blackwalltier.com)

If any of these fail, do NOT submit the PR — that's exactly the surprise you don't want a
reviewer to find. Fix it first (most likely: egress/DNS from the sandbox to
blackwalltier.com, or the plugin not registering in the onboarded runtime).
