# BLACK_WALL × OpenClaw — rootless Podman sandbox

A cheap, disposable **safety wrapper** for running an OpenClaw agent: BLACK_WALL
decides, the container contains, and the workspace is snapshot/roll-back-able.

## The two layers

| Layer | What | How |
|---|---|---|
| **Decision** | *Should this action happen?* | the BLACK_WALL plugin gates every tool call (`enforce` + `failClosed`) — a STOP-rated destructive action is blocked **before it runs** |
| **Containment** | *If it happens anyway, how much can it break?* | rootless Podman + `--cap-drop=ALL` + `no-new-privileges` + a disposable workspace volume — the agent can't reach the host, and you can roll the workspace back |

BLACK_WALL is the brain; the container is the blast wall. Neither replaces the other.

## Why plain Podman (not NemoClaw's sandbox) for this

NemoClaw's sandbox enforces **default-deny egress through a proxy**, and getting the
gate's `forecast()` calls out through that proxy is the unresolved blocker (the policy
didn't take without a gateway restart). A plain rootless Podman container has **normal
egress** — the gate reaches `blackwalltier.com` directly, no proxy dance — so it's the
faster path to a working, demonstrable block. (If your droplet *does* sit behind a
proxy, set `HTTPS_PROXY` in `blackwall.env`; the plugin CONNECT-tunnels through it
automatically — Node's `fetch` ignores it, the plugin handles it.)

## Prerequisites (on the droplet)

```bash
sudo apt-get update && sudo apt-get install -y podman   # Debian/Ubuntu
podman info | grep -i rootless                          # confirm rootless
```
No root, no daemon. Any $4–6/mo droplet works; for a free 24/7 host, Oracle Cloud
Always Free (4 ARM cores / 24 GB) runs this comfortably.

## Quickstart

```bash
cp blackwall.env.example blackwall.env     # then put your bw_live_ key in it
chmod +x *.sh

./build.sh            # build the image
./demo-blocked.sh     # PROVE it: destructive tool calls -> BLOCKED
```

Expected `demo-blocked.sh` output:

```
BLACK_WALL gate — mode=enforce failClosed=true base=https://blackwalltier.com

• shell.run  rm -rf --no-preserve-root /home/agent/wo  → STOP         🛑 BLOCKED — BLACK_WALL blocked tool "shell.run" (risk 9x/100): ...
• fs.delete  /home/agent/workspace                     → STOP         🛑 BLOCKED — BLACK_WALL blocked tool "fs.delete" (risk 9x/100): ...
• shell.run  echo hello from the sandbox               → GO           ✅ allowed (GO)

2/2 destructive calls blocked by a REAL verdict; benign echo ALLOWED ✅.
PASS — the gate genuinely DISCRIMINATED: it stopped the destructive calls and let the benign one through.
```

That demo drives the **real plugin gate** (no mocks, no LLM key) — it's the security
property, isolated and reproducible. Each block also mints an Ed25519-signed receipt
you can verify offline.

**The demo only PASSES when the gate genuinely discriminates** — destructive calls
blocked by a real STOP/CAUTION verdict **and** the benign `echo` allowed. If BLACK_WALL
is **unreachable** (no egress / bad key), `failClosed` blocks every call without scoring
anything; the demo reports **INCONCLUSIVE (exit 3)**, never PASS — a network failure can't
masquerade as a working gate. Exit codes: `0` = PASS, `1` = FAIL, `3` = INCONCLUSIVE.
Fix egress with `deploy/nemoclaw/egress-doctor.mjs` and re-run.

## The full agent (optional)

```bash
# add OPENROUTER_API_KEY (or your model key) to blackwall.env, then:
./run-agent.sh        # drops you into the hardened container
# inside: start the agent with your openclaw build's run command, then prompt it to
# do something destructive and watch before_tool_call -> BLACK_WALL block it.
```

## Reversibility — snapshot / roll back

A disposable, snapshot-able environment is what makes "irreversible" actions reversible
— it's the *enforcement* half of BLACK_WALL's reversibility score.

```bash
./snapshot.sh                                   # before a risky run
# ... let the agent run ...
./reset.sh blackwall-workspace snapshots/blackwall-workspace-YYYYMMDD-HHMMSS.tar
```

`snapshot.sh` exports the workspace volume to a tarball; `reset.sh` recreates the
volume from it (clean restore). Stop the agent container before resetting.

## Hardening rationale

- `--cap-drop=ALL` — the agent needs zero Linux capabilities; drop them all.
- `--security-opt no-new-privileges` — no setuid escalation inside.
- `--userns=keep-id` — container `agent` user maps to *you* (rootless); a container
  "root" is not host root.
- `--read-only` + `tmpfs` (demo) — the proof writes nothing; lock the rootfs.
- workspace as a named **volume** — the only place the agent persists, and the unit
  you snapshot/reset.
- keys via `--env-file` — **never baked into the image** (a Dockerfile `ENV` would
  leak into every layer and `podman history`).

## When to upgrade the containment

This is namespace/cgroup isolation (shares the host kernel) — the right "good enough"
to pair with the gate. If your threat model hardens to *"the agent is genuinely
untrusted and might try to escape the box,"* move the containment layer to a true
microVM: **Firecracker** (needs KVM / nested virt — not on basic droplets) or
**Fly.io** (Firecracker-as-a-service, no KVM host to manage). The decision layer
(this plugin) is unchanged either way.

## Security notes

- `blackwall.env` and `snapshots/` are git-ignored. Keep your `bw_live_` key out of
  version control and shell history.
- The gate **fails closed** here (`BLACKWALL_FAIL_CLOSED=1`): if BLACK_WALL is
  unreachable in `enforce` mode, the action is **blocked**, not run unscored.
