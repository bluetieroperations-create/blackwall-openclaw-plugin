#!/usr/bin/env node
/**
 * BLACK_WALL relay (Plan C) — a tiny, zero-dependency allowlisted forwarder.
 *
 * Use this ONLY when egress-doctor shows NemoClaw's proxy refuses CONNECT to
 * blackwalltier.com (hard block, or a TLS-intercepting proxy that breaks the
 * end-to-end tunnel). Topology:
 *
 *   [ NemoClaw sandbox ]  --plain HTTP-->  [ relay on the droplet HOST ]  --HTTPS-->  blackwalltier.com
 *
 * Why it defeats a CONNECT-refusing / TLS-MITM proxy: the sandbox never tries to
 * reach blackwalltier.com directly. It makes a *plain HTTP* request to ONE
 * allowlisted local endpoint (this relay) — which proxies pass far more readily
 * than a CONNECT tunnel — and the relay (with normal egress) does the real TLS.
 *
 * Point the plugin / egress-doctor at it:
 *   BLACKWALL_BASE_URL=http://<host-ip>:8787   NO_PROXY=<host-ip>
 *
 * SECURITY POSTURE (this is a network-exposed forwarder — it is deliberately small):
 *   - NOT an open proxy: upstream host is LOCKED to BLACKWALL_UPSTREAM; the client
 *     controls only the path, which must match the API allowlist below.
 *   - Holds NO key: the bw_live_ key rides in the caller's Authorization header,
 *     forwarded as-is; the relay never stores or injects it.
 *   - Fail-safe bind: defaults to 127.0.0.1. Set RELAY_BIND to the host IP the
 *     sandbox reaches, and FIREWALL that port off the public internet.
 *   - Body cap + upstream timeout to bound abuse.
 */
import http from 'node:http';

const PORT     = Number(process.env.RELAY_PORT || 8787);
const BIND     = process.env.RELAY_BIND || '127.0.0.1';            // fail-safe; override to host IP
const UPSTREAM = (process.env.BLACKWALL_UPSTREAM || 'https://blackwalltier.com').replace(/\/$/, '');
const TOKEN    = process.env.RELAY_TOKEN || '';                    // optional; NOTE: the plugin can't send it (see PLAN-C.md)
const MAX_BODY = Number(process.env.RELAY_MAX_BODY || 256 * 1024); // forecasts are a few KB
const UP = new URL(UPSTREAM);

// Lock the surface to exactly what the gate + doctor call. The client supplies the
// path only; it is appended to the FIXED upstream host (no SSRF — host is not steerable).
const ALLOW = [
  /^\/api\/v1\/forecast(\/|$|\?)/,
  /^\/api\/v1\/receipts(\/|$|\?)/,
  /^\/\.well-known\/blackwall-/,
];

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (TOKEN && req.headers['x-relay-token'] !== TOKEN) return send(403, { error: 'relay: forbidden' });

  const path = req.url || '/';
  if (!ALLOW.some((re) => re.test(path))) return send(404, { error: 'relay: path not allowed', path });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('error', () => { aborted = true; });
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) { aborted = true; send(413, { error: 'relay: body too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // Forward only the headers the API needs. Host is set to the real upstream;
    // hop-by-hop / proxy / relay headers are intentionally dropped.
    const headers = { accept: 'application/json', host: UP.host };
    if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
    if (req.headers['content-type'])  headers['content-type']  = req.headers['content-type'];

    try {
      const upstream = await fetch(`${UPSTREAM}${path}`, {
        method: req.method,
        headers,
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
        signal: AbortSignal.timeout(Number(process.env.RELAY_TIMEOUT_MS || 20000)),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(buf);
      console.log(`${req.method} ${path.split('?')[0]} -> ${upstream.status} (${buf.length}b)`);
    } catch (e) {
      console.error(`relay error ${req.method} ${path.split('?')[0]}: ${e.message}`);
      send(502, { error: 'relay: upstream failed', message: e.message });
    }
  });
});

server.on('error', (e) => { console.error('relay server error:', e.message); process.exit(1); });
server.listen(PORT, BIND, () => {
  console.log(`BLACK_WALL relay: http://${BIND}:${PORT}  ->  ${UPSTREAM}`);
  console.log(`Sandbox env:  BLACKWALL_BASE_URL=http://<host-ip>:${PORT}  NO_PROXY=<host-ip>`);
  if (BIND === '127.0.0.1') console.log('NOTE: bound to loopback — the sandbox cannot reach it yet. Set RELAY_BIND to the host IP the sandbox reaches, and firewall that port.');
  if (!TOKEN) console.log('NOTE: no RELAY_TOKEN — rely on RELAY_BIND + a host firewall to limit who reaches this port.');
});
