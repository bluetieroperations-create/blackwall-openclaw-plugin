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
 *   - Bounded: body cap + connection cap + request/header/upstream timeouts, so a
 *     flood of slow/half-open clients can't exhaust host memory.
 */
import http from 'node:http';

const PORT     = Number(process.env.RELAY_PORT || 8787);
const BIND     = process.env.RELAY_BIND || '127.0.0.1';            // fail-safe; override to host IP
const UPSTREAM = (process.env.BLACKWALL_UPSTREAM || 'https://blackwalltier.com').replace(/\/$/, '');
const TOKEN    = process.env.RELAY_TOKEN || '';                    // optional; NOTE: the plugin can't send it (see PLAN-C.md)
const MAX_BODY = Number(process.env.RELAY_MAX_BODY || 256 * 1024); // forecasts are a few KB
const UP = new URL(UPSTREAM);

// Lock the surface to exactly what the gate + doctor call. The client supplies the
// path only; it is appended to the FIXED upstream host. NOTE: the allowlist is checked
// against the NORMALIZED pathname (post-`new URL` dot-segment resolution), not the raw
// req.url — otherwise `/api/v1/forecast/../../../admin` normalizes to `/admin` and
// escapes the prefix. See the host/protocol hard-assert below for off-host defense.
const ALLOW = [
  /^\/api\/v1\/forecast(\/|$)/,
  /^\/api\/v1\/receipts(\/|$)/,
  /^\/\.well-known\/blackwall-/,
];

// Methods the API actually uses (GET well-known/receipts, POST forecast, PATCH observe/
// outcome, plus HEAD/OPTIONS as harmless). Forwarding arbitrary DELETE/PUT to the upstream
// with the caller's key is needless attack surface — reject anything else.
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH']);

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (TOKEN && req.headers['x-relay-token'] !== TOKEN) return send(403, { error: 'relay: forbidden' });

  if (!ALLOWED_METHODS.has(req.method)) return send(405, { error: 'relay: method not allowed' });

  const rawPath = req.url || '/';

  // Build + validate the upstream target ONCE, up front. This resolves dot-segments,
  // userinfo, and any authority trickery the same way fetch() will, so what we validate
  // is exactly what we send. Reject if the path doesn't start with '/' (absolute-form /
  // authority-form request targets), if the URL won't parse, if it resolves off-host, or
  // if the normalized pathname falls outside the allowlist.
  if (rawPath[0] !== '/') return send(404, { error: 'relay: path not allowed' });
  let target;
  try {
    target = new URL(`${UPSTREAM}${rawPath}`);
  } catch {
    return send(400, { error: 'relay: bad request target' });
  }
  // Hard-assert host + scheme (defense-in-depth — no observed bypass, but cheap and total).
  if (target.protocol !== UP.protocol || target.host !== UP.host) {
    return send(502, { error: 'relay: refused off-host target' });
  }
  // Re-check the NORMALIZED pathname against the allowlist (closes the dot-segment bypass).
  if (!ALLOW.some((re) => re.test(target.pathname))) {
    return send(404, { error: 'relay: path not allowed' });
  }

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

    // Forward only the headers the API needs. fetch() derives the Host header from the
    // target URL authority (an explicit `host` here would be ignored), so the upstream
    // always sees blackwalltier.com. Hop-by-hop / proxy / relay / attacker headers are
    // intentionally dropped — only authorization + content-type pass through.
    const headers = { accept: 'application/json' };
    if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
    if (req.headers['content-type'])  headers['content-type']  = req.headers['content-type'];

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
        signal: AbortSignal.timeout(Number(process.env.RELAY_TIMEOUT_MS || 20000)),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(buf);
      console.log(`${req.method} ${target.pathname} -> ${upstream.status} (${buf.length}b)`);
    } catch (e) {
      console.error(`relay error ${req.method} ${target.pathname}: ${e.message}`);
      send(502, { error: 'relay: upstream failed', message: e.message });
    }
  });
});

// Bound resource use: cap concurrent connections (each may buffer up to MAX_BODY)
// and time out slow / half-open clients so a trickle of stalled requests can't pin
// host memory. Backpressure for a firewalled demo relay — tune via env for real load.
server.maxConnections = Number(process.env.RELAY_MAX_CONN || 64);
server.requestTimeout = Number(process.env.RELAY_REQUEST_TIMEOUT_MS || 35000); // > upstream timeout (20s default)
server.headersTimeout = Number(process.env.RELAY_HEADERS_TIMEOUT_MS || 10000);

server.on('error', (e) => { console.error('relay server error:', e.message); process.exit(1); });
server.listen(PORT, BIND, () => {
  console.log(`BLACK_WALL relay: http://${BIND}:${PORT}  ->  ${UPSTREAM}`);
  console.log(`Sandbox env:  BLACKWALL_BASE_URL=http://<host-ip>:${PORT}  NO_PROXY=<host-ip>`);
  console.log(`limits: maxConn=${server.maxConnections}  requestTimeout=${server.requestTimeout}ms  bodyCap=${MAX_BODY}B`);
  if (BIND === '127.0.0.1') console.log('NOTE: bound to loopback — the sandbox cannot reach it yet. Set RELAY_BIND to the host IP the sandbox reaches, and firewall that port.');
  if (!TOKEN) console.log('NOTE: no RELAY_TOKEN — rely on RELAY_BIND + a host firewall to limit who reaches this port.');
});
