# Run BLACK_WALL on NVIDIA NemoClaw

Add a **pre-action risk gate** to agents running in an NVIDIA NemoClaw sandbox. BLACK_WALL
hooks `before_tool_call` and checks every tool call *before it executes* — blocking
destructive, irreversible, or exfiltration-style actions a compromised or mistaken agent
might attempt, independent of the model's own judgment.

Validated end-to-end in a real onboarded NemoClaw sandbox (OpenShell, OpenClaw 2026.5.22):
a live agent's `rm -rf --no-preserve-root` was returned **STOP (risk 98)** and **refused
before execution**; benign tool calls returned **GO** and proceeded.

---

## 1. Get your free API key (30 seconds)

BLACK_WALL is the API the plugin calls. Create a free account and grab a key:

👉 **https://blackwalltier.com/dashboard/keys**

The free tier covers ~100 forecasts/month — enough to trial the gate end-to-end. Keep the
key secret; you'll inject it into the sandbox in step 3.

## 2. Onboard your sandbox

Stand up a normal NemoClaw sandbox first. You add BLACK_WALL to the **running** sandbox in
step 3 — *not* by baking it into the image (see the box at the end of step 3 for why a
Dockerfile install bricks the gateway).

```console
$ nemoclaw onboard --name myagent
```

Wait for `nemoclaw myagent status` to show the gateway running and inference healthy.

## 3. Install the plugin into the running sandbox

NemoClaw sandboxes run with locked-down egress (no arbitrary `git clone` — github is
proxy-blocked — and npm is a cache-only proxy), so you **prepare the plugin on a machine with
normal internet, copy it in, and register it as the sandbox user.**

**3a. Prepare the plugin** on your workstation (Node 22, open internet):

```console
$ git clone https://github.com/bluetieroperations-create/blackwall-openclaw-plugin
$ cd blackwall-openclaw-plugin
$ npm ci --omit=peer --omit=dev --no-audit --no-fund
   # --omit=peer: don't vendor the `openclaw` peer (breaks the install's peer-link step)
   # --omit=dev:  skip esbuild (build-only)
$ find . -type f -links +1 -exec sh -c 'cp -p "$1" "$1.u" && mv -f "$1.u" "$1"' _ {} \;
   # openclaw's installer rejects hardlinked files; break any npm-cache hardlinks
```

**3b. Copy it in and register it AS the sandbox user (uid 998).** Installing as `root`
rewrites NemoClaw's managed `openclaw.json` and breaks the gateway; installing as the sandbox
user *merges* into it (the gateway config is preserved):

```console
$ CID=$(docker ps --filter name=openshell- --format '{{.ID}}' | head -1)   # podman if podman
$ docker cp . "$CID":/tmp/bwplugin
$ docker exec -u root "$CID" chown -R 998:998 /tmp/bwplugin
$ docker exec -u 998 "$CID" bash -lc 'HOME=/sandbox openclaw plugins install /tmp/bwplugin --force'
```

**3c. Deliver your API key — as a *file*, not an env var.** NemoClaw scrubs the
Gateway-spawned agent's environment, so neither Docker `ENV` nor an `/etc/profile.d` export
reaches the gating agent process (`process.env.BLACKWALL_API_KEY` is empty inside the agent
even though a login shell sees it). The plugin therefore also reads its key from a file the
agent can read. Write it as the sandbox user under the agent's `OPENCLAW_HOME`:

```console
$ read -rs KEY    # paste bw_live_… (not echoed)
$ docker exec -u 998 "$CID" sh -c \
    'umask 077; mkdir -p /sandbox/.openclaw; printf "%s" "$0" > /sandbox/.openclaw/blackwall.key' "$KEY"
$ docker exec -u root "$CID" sh -c \
    'printf "export BLACKWALL_MODE=observe\n" > /etc/profile.d/blackwall.sh; chmod a+r /etc/profile.d/blackwall.sh'
```

The plugin resolves the key from (in order) `config.apiKey` → `BLACKWALL_API_KEY` →
`$BLACKWALL_API_KEY_FILE` → `$OPENCLAW_HOME/.openclaw/blackwall.key` →
`$HOME/.openclaw/blackwall.key` → a path relative to the installed plugin bundle — so the
file above is picked up even under the scrubbed agent env. `observe` logs verdicts but never
blocks — safe for a trial; switch to `enforce` (and `BLACKWALL_FAIL_CLOSED=true`, recommended
for sandboxes) once you trust it. The key lives only in the running container — not in any
image layer or your Dockerfile.

**3d. Reload the gateway** so the agent re-spawns with the plugin and key:

```console
$ nemoclaw myagent recover
```

> **Verified end-to-end** (NemoClaw v0.0.55 / OpenClaw 2026.5.22, fresh sandbox): after these
> steps the gateway reports **running**, `openclaw config validate` passes, `openclaw plugins
> inspect blackwall-openclaw-plugin` shows `Status: loaded · Format: openclaw` with
> `before_tool_call` / `after_tool_call`, and the plugin's startup `No apiKey configured`
> warning is **gone** (the key-file reached it under the scrubbed agent env).

> **Why not bake it into a Dockerfile?** `openclaw plugins install` writes `openclaw.json`. At
> image-build time that file is created *before* `nemoclaw onboard` configures the gateway, so
> the onboard can't write `gateway.mode` / auth and **the gateway refuses to start**. Run as
> `root` at runtime it rewrites the onboard's config and drops the gateway section — same
> brick. Installing as the **sandbox user (998) into an already-onboarded sandbox** is the only
> non-destructive path. Without a key the plugin still loads but **fails open** (`No apiKey
> configured`, no gating).

## 4. Network egress

The plugin calls `https://blackwalltier.com`. NemoClaw **default-denies** this host (the
egress proxy returns `403` on the `CONNECT`), so you must add an allow preset — otherwise the
gate fails open. Two details matter: use `access: full` + `tls: skip` (a raw L4 passthrough;
the proxy's MITM otherwise stalls the TLS handshake), and allowlist the `node` binary that
makes the call. Apply it **after onboard**:

```yaml
# policy/blackwall-egress.yaml
preset:
  name: blackwall-egress
  description: "BLACK_WALL pre-action risk gate API access"
network_policies:
  blackwall:
    name: blackwall
    endpoints:
      - host: blackwalltier.com
        port: 443
        access: full      # raw passthrough — do not MITM
        tls: skip          # proxy MITM stalls the handshake; skip it
        enforcement: enforce
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
```

```console
$ nemoclaw myagent policy-add --from-file policy/blackwall-egress.yaml --yes
```

## 5. Verify it's gating

Inside the onboarded sandbox:

```console
$ openclaw plugins inspect blackwall-openclaw-plugin
Format: openclaw   ·   before_tool_call (priority 80), after_tool_call (priority 80)
```

Drive a benign call and a dangerous one; you'll see one line per gated tool call:

```
[blackwall] enforce · read → GO (risk 5/100, forecast …)
[blackwall] enforce · run_sql → STOP (risk 99/100, forecast …)   ← blocked before it ran
```

## Configuration

Set via env (or `createBlackwallPlugin({...})`):

| Env | Meaning |
|---|---|
| `BLACKWALL_API_KEY` | your key (required for gating) |
| `BLACKWALL_MODE` | `observe` (default — log only) or `enforce` (block STOP) |
| `BLACKWALL_FAIL_CLOSED` | `true` → block when the gate is unreachable (recommended for sandboxes) |
| `BLACKWALL_BASE_URL` | API base (default `https://blackwalltier.com`) |

Every verdict carries an **Ed25519-signed receipt** you can verify offline — a tamper-evident
record of what the agent was about to do and why it was allowed or blocked.

---

*Questions or want a hand wiring this into your deployment? → https://blackwalltier.com*
