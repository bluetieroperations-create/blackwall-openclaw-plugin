# blackwall-openclaw-plugin

Pre-action risk check for [OpenClaw](https://github.com/openclaw/openclaw) agents. Hooks `before_tool_call` so STOP-rated actions can be **blocked before they run** — without modifying your character, tools, or other plugins.

Powered by [BLACK_WALL](https://blackwalltier.com). Get a free key at [blackwalltier.com/dashboard/keys](https://blackwalltier.com/dashboard/keys).

## Install

```bash
npm i blackwall-openclaw-plugin
```

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "blackwall-openclaw-plugin": { enabled: true }
    }
  }
}
```

Set the env var (in your shell, `~/.openclaw/.env`, or the launcher):

```bash
BLACKWALL_API_KEY=bw_live_xxx
BLACKWALL_MODE=observe     # or 'enforce' once you trust the verdicts
```

That's it. Every tool the agent tries to call goes through `before_tool_call` → BLACK_WALL forecast → verdict.

## Where this plugin runs

This plugin uses OpenClaw's standard `before_tool_call` hook contract. Because every major OpenClaw wrapper preserves that contract, this single package works across the wider ecosystem with the install above. No wrapper-specific build needed for most.

| Host | Compatibility | Install path |
|---|---|---|
| **OpenClaw** (canonical) | ✅ | The install snippet above. |
| **NVIDIA NemoClaw** (sandbox runtime) | ✅ — see deployment note below | Install at runtime into the onboarded sandbox (as uid 998). See [`docs/nemoclaw.md`](docs/nemoclaw.md). |
| **AionUi** (multi-CLI cowork app) | ✅ | Install in your underlying OpenClaw; AionUi spawns OpenClaw and picks up the plugin transparently. |
| **HiClaw** (Kubernetes multi-runtime orchestrator) | ✅ | Install in the OpenClaw Worker container's image. Worker Template Marketplace inclusion is on our roadmap. |
| **ClawX** (desktop GUI) | ✅ | Install in your underlying OpenClaw. |
| **openclaw-mission-control / openclaw-control-center / openclaw-studio** | ✅ | Same — wrapper picks up the plugin from your local OpenClaw. |
| **openclaw-china-docker / openclaw-termux / OpenClawInstaller** | ✅ | Standard install inside their bundled OpenClaw. |

### NVIDIA NemoClaw deployment note

NemoClaw runs OpenClaw inside a security-hardened sandbox container. **Add BLACK_WALL to the
running, already-onboarded sandbox — do _not_ bake it into the image.** A build-time
`openclaw plugins install` pre-creates `openclaw.json` *before* `nemoclaw onboard` writes the
gateway config, so the onboard can't set `gateway.mode` / auth and **the gateway never
starts**. Running the install as `root` at runtime rewrites the same managed config and drops
the gateway section — same brick. The only non-destructive path is to install **as the
sandbox user (uid 998) into an onboarded sandbox**, deliver the key via `/etc/profile.d`
(NemoClaw does **not** propagate Docker `ENV` to the agent), then `nemoclaw <name> recover`.

**→ Full, end-to-end-verified walkthrough: [`docs/nemoclaw.md`](docs/nemoclaw.md).** Verified
on a fresh sandbox (NemoClaw v0.0.55 / OpenClaw 2026.5.22): gateway running, `openclaw config
validate` passes, `openclaw plugins inspect` shows `Status: loaded · Format: openclaw` with
`before_tool_call` / `after_tool_call`, and the key reaches the plugin (its startup `No apiKey
configured` warning clears). See **NemoClaw egress** below for the network policy the plugin
needs.

### NemoClaw egress — the plugin needs `blackwalltier.com` allowed

NemoClaw sandboxes enforce **default-deny egress through a proxy** (`HTTPS_PROXY`). The plugin's `forecast()`/`observe()` calls to `https://blackwalltier.com` are blocked until you add a network policy, or the gate silently **fails open** (logs `forecast() failed … proceeding without gate`). Add this custom preset:

```yaml
# blackwall-egress.yaml
preset:
  name: blackwall-egress
network_policies:
  blackwall:
    name: blackwall
    endpoints:
      - host: blackwalltier.com
        port: 443
        access: full
```

```bash
nemoclaw <sandbox> policy-add blackwall-egress --from-file blackwall-egress.yaml --yes
```

(Custom `BLACKWALL_BASE_URL`? Use that host instead.) In the live run this YAML **loaded** in the real sandbox (`Policy version … loaded`), but end-to-end egress to `blackwalltier.com` through the sandbox proxy was **not** confirmed working in-session — the proxy did not honor the new policy without a gateway recover/restart, so a live forecast round-trip from inside the sandbox is still **pending**. Treat this preset as the right shape, not a proven-working egress path; verify connectivity (e.g. a `curl https://blackwalltier.com` from inside the sandbox) after applying it.

**Default blueprint inclusion is on our roadmap.** Once accepted into `nemoclaw-blueprint/openclaw-plugins/`, every NemoClaw deployment will include pre-action gating by default with no Dockerfile work needed.

## What you get back per tool call

- `GO` / `CAUTION` / `STOP`
- risk score 0–100
- reversibility class (REVERSIBLE / RECOVERABLE / IRREVERSIBLE)
- named red flags — e.g. `SQL_NO_WHERE`, `PROMPT_INJECTION_LIKELY`, `IRREVERSIBLE_NO_BACKUP`
- an Ed25519-signed Decision Receipt — verifiable offline against the published public key

Round trip ~4–8s.

## Modes

| Mode | Behavior |
|---|---|
| `observe` (default) | Score every tool call and log to BLACK_WALL; never block. Zero behavior change — safe to drop in. |
| `enforce` | **STOP** → hard block (returns `{ block: true }`). **CAUTION** → surfaces an approval prompt natively via OpenClaw's `requireApproval`. **GO** → proceeds. |

Start in `observe` for a few days to see what the verdicts look like on your real traffic. Switch to `enforce` once you trust the scoring.

## Configurable CAUTION behavior

```js
import { createBlackwallPlugin } from 'blackwall-openclaw-plugin';

export default createBlackwallPlugin({
  mode: 'enforce',
  cautionAction: 'approve',  // 'approve' (default) | 'block' | 'allow'
});
```

- `approve` — fires OpenClaw's built-in approval prompt with the named red flags. User decides per call.
- `block` — treats CAUTION as STOP. Hard block.
- `allow` — treats CAUTION as GO. Lets it run, just observed.

## Why hook into `before_tool_call`?

OpenClaw's plugin SDK exposes [`before_tool_call`](https://docs.openclaw.ai/plugins/hooks) as an official typed hook with `block` + `requireApproval` return semantics — exactly the shape a pre-action guardrail needs. The plugin does **not** monkey-patch the dispatcher; it uses the documented extension surface.

That means:

- Priority-ordered with other policy hooks (defaults to `priority: 80`)
- Per-hook timeout (`timeoutMs: 15_000` by default — a hung forecast can't stall the agent)
- Native `requireApproval` flow for CAUTION verdicts
- Hot-reloadable via the gateway

## Companion skills

This package also ships two OpenClaw skills under `./skills/` that you can install into `~/.openclaw/skills/`:

- **`/blackwall-policy`** — Explains what BLACK_WALL is gating in this session, the failure-mode codes, and why a tool was blocked. Read by the agent when a `failureResult` references BLACK_WALL.
- **`/blackwall-verify`** — Verifies a Decision Receipt cryptographically (offline against the published public key, or via the hosted stateless verify endpoint).

Copy them in:

```bash
cp -r node_modules/blackwall-openclaw-plugin/skills/* ~/.openclaw/skills/
```

(or symlink for development).

## Full config reference

```js
createBlackwallPlugin({
  apiKey: process.env.BLACKWALL_API_KEY,    // or set BLACKWALL_API_KEY
  baseUrl: 'https://blackwalltier.com',     // override for self-hosted/staging
  mode: 'enforce',                          // 'observe' (default) | 'enforce'
  cautionAction: 'approve',                 // 'approve' (default) | 'block' | 'allow'
  shouldGate: (toolName) => toolName !== 'no_op',  // per-tool opt-out
  maxInputBytes: 8 * 1024,                  // truncate forecast payload over this size
  forecastTimeoutMs: 15_000,                // per-hook timeout
  onEvent: (event) => myTelemetry(event),   // optional telemetry hook
});
```

### Telemetry events emitted via `onEvent`

`register`, `skipped`, `observed`, `stop`, `require_approval`, `forecast_error`, `observe_error`, `observed_outcome`.

## How it works

```
                     ┌──────────────────────────────┐
                     │ OpenClaw agent decides to    │
                     │ call tool X with params Y    │
                     └─────────────┬────────────────┘
                                   │
                          before_tool_call
                                   │
                                   ▼
            ┌──────────────────────────────────────────┐
            │ blackwall plugin: forecast(X, Y)          │
            │ ↓                                          │
            │ STOP   → return { block: true,             │
            │           blockReason: "..." }             │
            │ CAUTION → return { requireApproval: {...}} │
            │ GO     → return undefined                 │
            └──────────────────┬───────────────────────┘
                               │ (if not blocked)
                               ▼
                       tool actually runs
                               │
                          after_tool_call
                               │
                               ▼
            ┌──────────────────────────────────────────┐
            │ blackwall plugin: observe(forecast_id,    │
            │   outcome_class)                          │
            │ matched / diverged / aborted              │
            └──────────────────────────────────────────┘
```

Fail-open: if BLACK_WALL is unreachable, the hook logs a warning and lets the tool proceed. A BLACK_WALL outage will never take down your agent.

## Architecture

```
┌──────────────────────────────────────────────┐
│ BLACK_WALL HTTP API (stable, versioned)      │
└──────────────────────────────────────────────┘
              ▲
┌──────────────────────────────────────────────┐
│ blackwall-mcp/lib  (shared client logic)     │
│   - forecast()                                │
│   - observe()                                 │
└──────────────────────────────────────────────┘
              ▲
┌──────────────────────────────────────────────┐
│ blackwall-openclaw-plugin (this package)     │
│   - before_tool_call hook                     │
│   - after_tool_call hook                      │
└──────────────────────────────────────────────┘
              ▲
            OpenClaw
```

When OpenClaw ships breaking changes to its plugin contract, only this package needs to update. The HTTP API, the `blackwall-mcp` library, the MCP server, and every other BLACK_WALL integration remain insulated.

## Links

- Site & docs: https://blackwalltier.com
- Free API key: https://blackwalltier.com/dashboard/keys
- Failure-mode taxonomy (28 named red-flag codes): https://blackwalltier.com/failure-modes
- npm: [`blackwall-openclaw-plugin`](https://www.npmjs.com/package/blackwall-openclaw-plugin) · [`blackwall-mcp`](https://www.npmjs.com/package/blackwall-mcp)
- Source: https://github.com/bluetieroperations-create/blackwall-openclaw-plugin
- Sibling plugin (ElizaOS): [`blackwall-eliza-guardrail`](https://www.npmjs.com/package/blackwall-eliza-guardrail)

## License

MIT
