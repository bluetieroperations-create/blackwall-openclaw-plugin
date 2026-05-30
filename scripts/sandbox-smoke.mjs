// Sandbox smoke test — run INSIDE an onboarded NemoClaw sandbox to prove the
// before_tool_call hook fires and gates against the LIVE BLACK_WALL API from the
// sandbox's own network. This is the runtime proof the CI dockerfile job can't
// give (CI only proves the image builds + files land). See docs/sandbox-smoke-test.md.
//
//   BLACKWALL_API_KEY=bw_live_... node scripts/sandbox-smoke.mjs
//
// Exit 0 = the hook fired, a destructive call was gated, a benign call proceeded,
// and the live round-trip latency was recorded.

import { resolveConfig, handleBeforeToolCall } from '../src/gate.mjs';

if (!process.env.BLACKWALL_API_KEY) {
  console.error('Set BLACKWALL_API_KEY (the sandbox needs a live key to reach BLACK_WALL).');
  process.exit(1);
}

// enforce mode so a STOP verdict actually blocks (the thing a reviewer wants to see).
const cfg = resolveConfig({ mode: 'enforce' });

let fail = 0;
async function check(label, event, wantGated) {
  const t0 = Date.now();
  let r;
  try {
    r = await handleBeforeToolCall(event, cfg);
  } catch (e) {
    console.log(`FAIL  ${label} -> threw: ${e?.message ?? e}`);
    fail++;
    return;
  }
  const ms = Date.now() - t0;
  const gated = Boolean(r); // block OR requireApproval
  const how = r?.block ? 'BLOCKED' : r?.requireApproval ? 'APPROVAL-REQUIRED' : 'proceed';
  const ok = gated === wantGated;
  if (!ok) fail++;
  const detail = r?.blockReason ? ` · ${r.blockReason}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${how} (want ${wantGated ? 'gated' : 'proceed'}) · ${ms}ms round-trip${detail}`);
}

console.log('\nBLACK_WALL sandbox smoke — enforce mode, live API\n');

// 1. Destructive tool call -> high risk -> must be GATED (block or approval-required).
await check(
  'run_sql "DELETE FROM users" (destructive)',
  { toolName: 'run_sql', params: { statement: 'DELETE FROM users' }, toolCallId: 'smoke-destructive' },
  true
);

// 2. Benign read -> GO -> must PROCEED (hook returns undefined).
await check(
  'read "ping" (benign)',
  { toolName: 'read', params: { q: 'ping' }, toolCallId: 'smoke-benign' },
  false
);

console.log(
  fail === 0
    ? '\n✅ SANDBOX SMOKE PASSED — the before_tool_call hook fires inside the sandbox, reaches\n' +
        '   live BLACK_WALL, gates a destructive call, and lets a benign one through.\n'
    : `\n❌ ${fail} check(s) failed — see above.\n`
);
process.exitCode = fail === 0 ? 0 : 1;
