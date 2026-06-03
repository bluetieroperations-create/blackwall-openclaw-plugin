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

## 2. Bake the plugin into your sandbox image

NemoClaw runs OpenClaw inside a hardened sandbox, so you add the plugin by baking it into
the sandbox image and onboarding from that Dockerfile. `sandbox-base` already ships `git`,
so the simplest path pulls straight from the public repo:

```dockerfile
ARG SANDBOX_BASE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
FROM ${SANDBOX_BASE}

# Pull the plugin. Defaults to `main`; pin BLACKWALL_PLUGIN_REF to a release tag for production.
ARG BLACKWALL_PLUGIN_REF=main
RUN git clone --depth 1 --branch ${BLACKWALL_PLUGIN_REF} \
      https://github.com/bluetieroperations-create/blackwall-openclaw-plugin.git \
      /opt/blackwall-openclaw-plugin \
 && cd /opt/blackwall-openclaw-plugin \
 && npm ci --omit=peer --no-audit --no-fund

# Install + make readable for the unprivileged sandbox user (root builds; the agent runs
# non-root, so the baked files must be world-readable or the plugin silently fails to load).
RUN openclaw plugins install /opt/blackwall-openclaw-plugin --force \
 && chmod -R a+rX /sandbox/.openclaw/extensions/blackwall-openclaw-plugin \
 && openclaw doctor --fix

# Default to observe mode (logs verdicts, never blocks) so you can trial it safely.
# Switch to enforce once you trust it. failClosed=true is recommended for sandboxes.
ENV BLACKWALL_MODE=observe

WORKDIR /opt/nemoclaw
```

Then onboard:

```console
$ nemoclaw onboard --from ./Dockerfile
```

> Vendoring / no outbound git on the build host? `COPY` a local checkout into
> `/opt/blackwall-openclaw-plugin/` instead of the `git clone`, then run the same
> `npm ci --omit=peer` + `openclaw plugins install` + `chmod` + `openclaw doctor --fix`.

## 3. Give the sandbox your API key

The plugin reads `BLACKWALL_API_KEY` from the agent runtime. **Don't** bake it in with a bare
Dockerfile `ENV` — it isn't reliably seen by the NemoClaw gateway, *and* it would burn the
secret into the image layers.

Use NemoClaw's runtime secret substitution instead: reference the key with the
`openshell:resolve:env:BLACKWALL_API_KEY` placeholder and provide the real value as a
host-side secret, so OpenShell substitutes it inside the running sandbox — the key never
lands in the image or on disk. (Same mechanism NemoClaw uses for messaging-bridge tokens.)

> The exact CLI to register a *non-provider* plugin secret depends on your NemoClaw version —
> the first-class credential flows cover inference providers (`nemoclaw onboard`) and
> messaging bridges (`nemoclaw channels`). Check `nemoclaw credentials --help` / your version's
> secrets reference. Without a key the plugin loads but **fails open** (`No apiKey configured`,
> no gating).

## 4. Network egress

The plugin calls `https://blackwalltier.com`. On NemoClaw's **default / balanced** policy
tier this is permitted out of the box (validated 2026-06-02 — no proxy or custom preset
needed). If you run a **stricter default-deny** egress policy, allowlist the host or the
gate will fail open:

```yaml
# blackwall-egress.yaml — only needed under a stricter-than-balanced policy
preset:
  name: blackwall-egress
network_policies:
  blackwall:
    name: blackwall
    allow:
      - host: blackwalltier.com
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
