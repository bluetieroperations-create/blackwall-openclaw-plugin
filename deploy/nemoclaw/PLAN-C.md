# Plan C — the allowlisted relay (when the proxy refuses CONNECT)

Use this **only if `egress-doctor.mjs` reports**: proxy reachable, but the CONNECT
tunnel to `blackwalltier.com:443` is blocked **and** there's no direct egress —
i.e. the sandbox proxy hard-blocks CONNECT or TLS-intercepts it. (If the doctor
shows any other state, fix that instead; you don't need Plan C.)

## Why it works

```
 ┌─────────────────────┐   plain HTTP    ┌──────────────────────────┐   HTTPS    ┌────────────────────┐
 │   NemoClaw sandbox   │ ──────────────▶ │  relay on the droplet HOST │ ─────────▶ │  blackwalltier.com │
 │  (gate / forecast()) │  to ONE allow-   │  (normal internet egress)  │  real TLS  │     (the API)      │
 └─────────────────────┘  listed local IP └──────────────────────────┘            └────────────────────┘
```

The sandbox never tries to reach `blackwalltier.com` directly — so the proxy's
CONNECT refusal / TLS interception is irrelevant. It makes a **plain HTTP** request
to one allowlisted local endpoint (the relay), which proxies forward far more
readily than a CONNECT tunnel. The relay, running on the host with ordinary egress,
does the real HTTPS to the API.

## Steps

**1. Run the relay on the droplet HOST** (outside the sandbox). Needs Node 18+:

```bash
# bind to the host IP the sandbox can reach (NOT 0.0.0.0 on a public box)
RELAY_BIND=10.0.0.5 RELAY_PORT=8787 node deploy/nemoclaw/blackwall-relay.mjs
```

No Node on the host? Run it in a throwaway container instead:

```bash
podman run --rm -p 8787:8787 -e RELAY_BIND=0.0.0.0 \
  -v "$PWD/deploy/nemoclaw/blackwall-relay.mjs:/relay.mjs:ro" \
  docker.io/library/node:22-slim node /relay.mjs
# then firewall 8787 to the sandbox only (see security notes)
```

**2. Allowlist the relay in the NemoClaw network policy** — the sandbox needs to
reach `<host-ip>:8787` (this replaces the `blackwalltier.com:443` rule):

```yaml
# blackwall-relay.yaml
preset:
  name: blackwall-relay
network_policies:
  blackwall_relay:
    name: blackwall_relay
    endpoints:
      - host: 10.0.0.5      # the host IP RELAY_BIND is on
        port: 8787
        access: full
```

```bash
nemoclaw <sandbox> policy-add blackwall-relay --from-file blackwall-relay.yaml --yes
nemoclaw <sandbox> recover     # policies don't take effect live
```

**3. Point the gate at the relay** (inject as NemoClaw secrets, not Dockerfile ENV):

```
BLACKWALL_BASE_URL=http://10.0.0.5:8787
NO_PROXY=10.0.0.5
```

`NO_PROXY` makes the gate hit the relay **directly** (plain HTTP, no proxy); the
relay handles the TLS leg. The bw_live_ key is unchanged — it rides through.

**4. Verify** from inside the sandbox:

```bash
node /opt/blackwall-openclaw-plugin/deploy/nemoclaw/egress-doctor.mjs
# [4] forecast() round-trip should now PASS through the relay.
# (checks [2]/[3] are about direct/proxy egress to the API and are N/A on Plan C —
#  what matters is [4].)
```

A `[4] PASS` means the gate works end-to-end via the relay — you can run the agent
and pursue the NemoClaw submission.

## Security notes (read before exposing the port)

- **The key crosses the sandbox→relay hop in cleartext** (plain HTTP). That hop is a
  private host link, which is acceptable for a demo. For an untrusted link, serve the
  relay over **HTTPS** (terminate TLS at the relay with a self-signed cert the sandbox
  trusts) — same forwarding logic, `https://` base URL.
- **Bind tight + firewall.** Default `RELAY_BIND=127.0.0.1` is fail-safe (unreachable
  from the sandbox until you widen it). Set it to the host's sandbox-facing IP and add
  a host firewall rule so **only the sandbox subnet** can reach the port — never leave
  `0.0.0.0:8787` open to the public internet on a droplet.
- **Not an open proxy.** Upstream is locked to `BLACKWALL_UPSTREAM` (the client can't
  steer the host); the path must match the forecast/receipts/well-known allowlist;
  body is capped. Worst case for someone who reaches the port: they can relay calls to
  `blackwalltier.com` **using their own key** — low value, and the firewall closes it.
- **`RELAY_TOKEN` caveat:** you can require an `X-Relay-Token` header, but the plugin's
  `forecast()`/`observe()` cannot add custom headers, so enabling it breaks the plugin
  path. Leave it unset for the gate; it's only useful for locking down manual `curl`
  access. Rely on bind + firewall instead.
- **Tear it down** after the session — it's demo plumbing, not a standing service.
