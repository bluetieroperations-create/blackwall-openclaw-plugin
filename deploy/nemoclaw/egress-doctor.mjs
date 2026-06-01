#!/usr/bin/env node
/**
 * egress-doctor — run INSIDE the NemoClaw sandbox to localize EXACTLY where the
 * BLACK_WALL forecast() egress round-trip breaks, and print the targeted fix.
 *
 *   node /opt/blackwall-openclaw-plugin/deploy/nemoclaw/egress-doctor.mjs
 *   (or copy this file in and: node egress-doctor.mjs)
 *
 * It exercises the plugin's REAL proxy-fetch + forecast() code paths — the same
 * ones the gate uses — so a PASS here means the gate will work in-sandbox.
 * Needs: the plugin installed (for blackwall-mcp), and BLACKWALL_API_KEY in THIS
 * process's env (NemoClaw: inject as a secret, not a Dockerfile ENV).
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

// --- locate the installed blackwall-mcp lib (paths vary by host) ---
const CANDIDATES = [
  process.env.BLACKWALL_MCP_LIB,
  '/opt/blackwall-openclaw-plugin/node_modules/blackwall-mcp/lib',
  '/sandbox/.openclaw/extensions/blackwall-openclaw-plugin/node_modules/blackwall-mcp/lib',
  `${process.env.HOME || ''}/.openclaw/extensions/blackwall-openclaw-plugin/node_modules/blackwall-mcp/lib`,
].filter(Boolean);
const MCP = CANDIDATES.find((p) => fs.existsSync(`${p}/proxy-fetch.mjs`));
if (!MCP) {
  console.error('FATAL: could not find blackwall-mcp/lib. Set BLACKWALL_MCP_LIB to its path.');
  console.error('Looked in:\n  ' + CANDIDATES.join('\n  '));
  process.exit(2);
}
const { proxyFetch } = await import(`${MCP}/proxy-fetch.mjs`);
const { forecast } = await import(`${MCP}/forecast.mjs`);

const BASE = (process.env.BLACKWALL_BASE_URL || 'https://blackwalltier.com').replace(/\/$/, '');
const HOST = new URL(BASE).hostname;
const HEALTH = `${BASE}/.well-known/blackwall-signing-keys.json`; // lightweight public GET
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const keySet = !!process.env.BLACKWALL_API_KEY;
const ok = (b) => (b ? 'PASS ✅' : 'FAIL ❌');
const log = (n, s) => console.log(`[${n}] ${s}`);

const tcp = (host, port, ms = 5000) =>
  new Promise((res) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
    s.once('error', () => { clearTimeout(t); res(false); });
  });
const directTLS = (host, ms = 6000) =>
  new Promise((res) => {
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    const s = tls.connect({ host, port: 443, servername: host }, () => { clearTimeout(t); s.destroy(); res(true); });
    s.once('error', () => { clearTimeout(t); res(false); });
  });

console.log(`\n=== BLACK_WALL egress-doctor — target ${BASE} ===\n`);

// [0] env present in THIS process?
log(0, `env: HTTPS_PROXY=${proxy || '(unset)'} | NO_PROXY=${process.env.NO_PROXY || '(unset)'} | ` +
       `BLACKWALL_API_KEY=${keySet ? `set (${process.env.BLACKWALL_API_KEY.length} chars)` : '(UNSET)'}`);

// [1] proxy reachable?
let proxyReachable = null;
if (proxy) {
  const u = new URL(proxy);
  proxyReachable = await tcp(u.hostname, Number(u.port) || 80);
  log(1, `proxy TCP reachable (${u.hostname}:${u.port || 80}): ${ok(proxyReachable)}`);
} else {
  log(1, 'no HTTPS_PROXY set — testing DIRECT egress only');
}

// [2] direct egress (bypass proxy)?
const direct = await directTLS(HOST);
log(2, `DIRECT TLS ${HOST}:443 (no proxy): ${ok(direct)}`);

// [3] proxy CONNECT tunnel — the exact path forecast() uses
let tunnelOk = false;
if (proxy) {
  try {
    const f = proxyFetch(proxy);
    const r = await f(HEALTH, { method: 'GET', signal: AbortSignal.timeout(8000) });
    tunnelOk = r.ok;
    log(3, `proxy CONNECT tunnel GET ${HOST} -> HTTP ${r.status}: ${ok(r.ok)}`);
  } catch (e) {
    log(3, `proxy CONNECT tunnel FAILED: ${e.message}`);
  }
} else {
  log(3, 'skipped (no proxy)');
}

// [4] full forecast() round-trip (routes through proxy automatically when set)
let forecastOk = false;
if (!keySet) {
  log(4, 'forecast() SKIPPED — BLACKWALL_API_KEY not in this process');
} else {
  try {
    const v = await forecast({ action: 'echo', inputs: { message: 'egress-doctor probe' }, context: { source: 'egress-doctor' } });
    forecastOk = true;
    log(4, `forecast() round-trip: ${ok(true)} -> ${v.recommendation} risk ${v.risk_score} receipt ${v.receipt?.id || '?'}`);
  } catch (e) {
    log(4, `forecast() round-trip FAILED: ${e.message}`);
  }
}

// --- diagnosis + targeted fix ---
console.log('\n--- diagnosis ---');
if (forecastOk) {
  console.log('✅ EGRESS WORKS END-TO-END. The gate will function in-sandbox. Ship the NemoClaw submission.');
} else {
  if (!keySet)
    console.log('• KEY MISSING in the process. A Dockerfile `ENV` is NOT seen by the NemoClaw agent runtime — inject BLACKWALL_API_KEY as a NemoClaw secret/credential, then re-run.');
  if (!proxy && direct)
    console.log('• Direct egress is OPEN and no proxy is set — the gate uses global fetch directly. If [4] still failed with the key set, it is the API, not egress.');
  if (!proxy && !direct)
    console.log('• No proxy AND direct egress blocked — set HTTPS_PROXY to the sandbox proxy (inject as a secret), then re-run.');
  if (proxy && proxyReachable === false)
    console.log('• Proxy is UNREACHABLE — HTTPS_PROXY host:port is wrong. Confirm the sandbox proxy address.');
  if (proxy && proxyReachable && !tunnelOk && direct)
    console.log(`• Proxy tunnel blocked but DIRECT works — add NO_PROXY=${HOST} (or a direct-egress policy) so the gate bypasses the proxy for this host.`);
  if (proxy && proxyReachable && !tunnelOk && !direct)
    console.log(
      `• Proxy is the only egress and CONNECT to ${HOST}:443 is BLOCKED — the network policy is not allowing it. In order:\n` +
      `    1. Apply the blackwall-egress policy (host ${HOST}, port 443, access full).\n` +
      `    2. RECOVER/RESTART the gateway — the policy does NOT take effect live (this is the step that was missed before).\n` +
      `    3. If still blocked, the proxy may require auth — put user:pass in HTTPS_PROXY (http://user:pass@proxy:port).\n` +
      `    4. If CONNECT is refused outright, the proxy may TLS-intercept — then point BLACKWALL_BASE_URL at an allowlisted relay instead.`
    );
  // Catch-all: egress to the host clearly WORKS (tunnel ok, or direct ok with no proxy)
  // and the key is present, yet forecast() still failed — so it is NOT an egress problem.
  if (keySet && ((proxy && proxyReachable && tunnelOk) || (!proxy && direct)))
    console.log(
      `• Egress to ${HOST} is OPEN and the key is set, but forecast() still FAILED — this is the API, not the network. ` +
      `Check: the key is valid/active (not a placeholder), BLACKWALL_BASE_URL=${BASE} points at the real API (not a relay/404), ` +
      `and the account has quota. See [4]'s error message above for the exact status.`
    );
}
console.log('');
process.exit(forecastOk ? 0 : 1);
