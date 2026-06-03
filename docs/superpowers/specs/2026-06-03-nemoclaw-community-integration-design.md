# BLACK_WALL × NemoClaw community integration — design

**Status:** approved in brainstorm 2026-06-03. Ready for implementation plan.
**Goal:** an accepted example under `NVIDIA/nemoclaw-community` that adds BLACK_WALL's pre-action risk gate to a stock OpenClaw agent on NemoClaw and demonstrates it blocking a destructive action live — winning NVIDIA recognition through a funnel-safe door (Path #2).

---

## 1. Approach (decided)

- **OpenClaw (NemoClaw's default agent) + our existing JS plugin** (`blackwall-openclaw-plugin`), installed via the **verified runtime-injection** method (the one proven on the droplet 2026-06-03; see `docs/nemoclaw.md`). NOT a Python rewrite — the repo's `plugin.yaml`+Python plugin convention is **Hermes-specific** (hooks into Hermes's runtime), so it doesn't apply to an OpenClaw integration.
- **Submitted as an *integration*, not a custom-agent showcase.** The two existing examples (`personal-community-sentiment-triage`, `hermes-launchable`) ship `agents/<name>/manifest.yaml` because they onboard a *custom* agent (Hermes). We use OpenClaw, NemoClaw's built-in default agent, so there is no custom agent to declare a manifest for. The README states this explicitly so the structural difference reads as a deliberate choice, not an omission.
- **Why not a build-time Dockerfile:** `openclaw plugins install` writes `openclaw.json`; baked at build time it pre-empts `nemoclaw onboard`'s gateway/auth/inference config and the gateway never starts (proven 2026-06-03). Runtime injection as the sandbox user (uid 998) is the only non-destructive path.

## 2. Structure

```
examples/blackwall-preflight-guard/
  README.md            # what/why, defense-in-depth framing, funnel (free key), setup, PROOF, teardown
  .env.example         # BLACKWALL_API_KEY= , BLACKWALL_MODE=enforce
  .gitignore
  setup.sh             # onboard -> prepare -> inject -> key -> recover -> egress
  teardown.sh          # nemoclaw <name> destroy
  demo.sh              # drive the 3 scenarios live; also `demo.sh --replay` (deterministic, no sandbox)
  scripts/
    prepare-plugin.sh  # host: clone @ pinned tag + npm ci --omit=peer --omit=dev + break hardlinks
    inject-plugin.sh   # docker cp + chown 998 + openclaw plugins install (as 998) + /etc/profile.d key + recover
  policy/
    blackwall-egress.yaml   # allow blackwalltier.com (only needed under stricter-than-balanced tiers)
  PROOF.md             # captured live GO/CAUTION/STOP output + signed receipt IDs from our droplet run
```

All scripts are **pure POSIX shell** (drive the `openclaw`/`nemoclaw` CLI + grep gate logs) — sidesteps the "their examples are Python, ours is JS" fit question and passes their `bash -n` check. Every file carries an SPDX/Apache-2.0 header (their `scripts/check_license_headers.py` enforces it).

> **TODO at plan time:** confirm whether `examples/` has a root index/README that a new example must be registered in; if so, the PR updates it.

## 3. Setup / teardown flow

`setup.sh`, idempotent and readable top-to-bottom:
1. `nemoclaw onboard --name blackwall-demo` (vanilla OpenClaw sandbox)
2. `scripts/prepare-plugin.sh` — on the host (open egress): `git clone --branch <PINNED_TAG>` + `npm ci --omit=peer --omit=dev --no-audit --no-fund` + break hardlinks (npm-cache hardlinks; openclaw's installer rejects them). *NemoClaw sandboxes block in-sandbox git clone and run npm cache-only, so prep must happen on the host and be copied in.*
3. `scripts/inject-plugin.sh` — `docker cp` the prepared dir into the sandbox container → `chown -R 998:998` → `openclaw plugins install <dir> --force` **as uid 998** (`HOME=/sandbox`; merges into onboard config, never clobbers) → write `BLACKWALL_API_KEY` to `/etc/profile.d/blackwall.sh` as root (Docker ENV does NOT reach the agent) → `nemoclaw blackwall-demo recover`.
4. apply `policy/blackwall-egress.yaml` only if the host runs a stricter-than-balanced egress tier.

`teardown.sh` → `nemoclaw blackwall-demo destroy --yes`.

README front-loads the *why* of runtime injection (honest, and useful signal to NVIDIA about their third-party-plugin story).

## 4. Demo mechanism

The plugin's `before_tool_call` hook fires only when the agent dispatches a tool call. Two modes:

**Live mode (headline)** — `demo.sh` drives the onboarded OpenClaw agent (enforce mode) with three explicit, unambiguous instructions; the agent emits the instructed command and **the gate decides on the command content** (deterministic for a given command — same pattern as the proven live-dispatch):

| step | instruction | tool call | expected verdict |
|---|---|---|---|
| GO | "report disk usage" | `du -sh *` | GO → runs |
| CAUTION | (recoverable-but-risky op — tuned at validation) | e.g. overwrite a log / `git reset --hard` | CAUTION → approval prompt |
| STOP | "free space by deleting /sandbox/data" | `rm -rf /sandbox/data` | STOP → blocked before exec |

> **Open at plan time:** (a) exact headless-drive mechanism — OpenClaw one-shot prompt vs gateway HTTP API — nailed during droplet validation; (b) the **CAUTION** scenario needs tuning so the middle verdict reliably lands CAUTION (GO and STOP are easy; a clean recoverable-risky middle is the hard one). The `--replay` payloads pin whatever lands CAUTION in validation.

**Replay mode (acceptance booster)** — `demo.sh --replay` needs *only* a free BLACK_WALL key (no NemoClaw, no Docker, no NVIDIA key): it sends the three crafted tool-call payloads straight to `forecast()` and prints GO/CAUTION/STOP + receipt IDs. A reviewer sees the gate work in ~30 seconds without standing up a sandbox. Built on the repo's existing `real-openclaw-test.mjs` direct-hook pattern.

`demo.sh` captures the plugin's `[blackwall] enforce · <tool> → <verdict>` log lines + signed receipt IDs and writes the results table to `PROOF.md`.

## 5. Positioning (README narrative)

It's labeled `area: security` — lead with **defense-in-depth**: BLACK_WALL *complements* NemoClaw's sandbox + egress controls (a third layer — pre-action intent gating — independent of the model's own judgment), not a competitor. **Showcase the Ed25519-signed receipts** as the unique angle: a tamper-evident, offline-verifiable record of what each agent was about to do and why it was allowed or blocked. Funnel: step 1 is "get a free key at blackwalltier.com/dashboard/keys."

## 6. Validation (before any PR)

Full end-to-end on one DigitalOcean droplet (Sam spins, Claude drives via SSH; ~$0.30–0.60, DO credit): run `setup.sh` fresh → drive the 3 live scenarios → capture real GO/CAUTION/STOP output + signed receipts into `PROOF.md` → run `demo.sh --replay` → run the repo's local checks (`check_license_headers.py`, `git diff --check`, `bash -n` on all shell). Destroy droplet after.

## 7. Submission — build now, submit on cue

- **Prerequisite:** cut a tagged release of `blackwall-openclaw-plugin` (e.g. `v0.1.5`) and pin the example's clone to that tag (an example that clones `main` silently breaks on the next plugin change).
- Fork `NVIDIA/nemoclaw-community`, branch, add the example, **DCO sign-off** (`git commit -s`) on every commit, Apache-2.0 headers on every file, pass local checks.
- **Hold the PR open-submission** for Will Curran's (`wscurran`, @NVIDIA) reply to the #4692 nudge — he floated nothing yet but we offered community there, so let him steer. **Timebox: if no steer in ~3–5 days, submit anyway** (the example is our chosen strategy regardless of #4692). If he says "fix the blueprint instead," re-evaluate; the community example still stands on its own.

## Non-goals
- No custom agent / no Hermes. No Python plugin port. No build-time Dockerfile bake. No on-chain/crypto content (Inception eligibility). Adapter B / deeper agent showcases deferred.
