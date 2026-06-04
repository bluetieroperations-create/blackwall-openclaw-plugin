#!/usr/bin/env node
/**
 * Smoke test — exercises ./src/gate.mjs without needing openclaw installed.
 *
 * Strategy: gate.mjs accepts forecast/observe overrides via the config, so we
 * inject mocks and drive handleBeforeToolCall / handleAfterToolCall with
 * synthetic OpenClaw events. Validates the result shape matches OpenClaw's
 * PluginHookBeforeToolCallResult contract.
 *
 * Run: npm test  (or: node smoke-test.mjs)
 */

import {
  resolveConfig,
  handleBeforeToolCall,
  handleAfterToolCall,
  pendingForecasts,
  truncateInputs,
  buildBlockReason,
  buildApprovalDescription,
} from './src/gate.mjs';

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    console.log(`  ok — ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL — ${label}`);
    failed += 1;
  }
}

function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/** Fake logger that captures warnings for assertions. */
function makeLogger() {
  const warnings = [];
  return { warn: (msg) => warnings.push(String(msg)), warnings };
}

/** Build a resolved config with default mocks. Override per test. */
function makeCfg({ mode = 'observe', cautionAction = 'approve', failClosed, forecastResult, forecastError, observeImpl, onEvent, shouldGate } = {}) {
  const events = [];
  const forecastCalls = [];
  const observeCalls = [];

  const forecast = async (args, opts) => {
    forecastCalls.push({ args, opts });
    if (forecastError) throw forecastError;
    return forecastResult ?? { id: 'fc_smoke', recommendation: 'GO', risk_score: 5, red_flags: [] };
  };
  const observe = observeImpl ?? (async (forecastId, args, opts) => {
    observeCalls.push({ forecastId, args, opts });
    return { ok: true };
  });

  const cfg = resolveConfig({
    apiKey: 'bw_live_test',
    baseUrl: 'https://blackwalltier.example',
    mode,
    cautionAction,
    failClosed,
    onEvent: onEvent ?? ((e) => events.push(e)),
    shouldGate,
    forecast,
    observe,
  });
  return { cfg, events, forecastCalls, observeCalls };
}

// ============================================================================

console.log('\n[1] observe mode — GO verdict → undefined, no block, no approval');
{
  pendingForecasts.clear();
  const { cfg, events, forecastCalls } = makeCfg({ mode: 'observe' });
  const logger = makeLogger();
  const result = await handleBeforeToolCall(
    { toolName: 'web_search', params: { query: 'hello' }, toolCallId: 'tc1', runId: 'r1' },
    cfg,
    logger
  );
  ok(result === undefined, 'before_tool_call returns undefined (proceed)');
  eq(forecastCalls.length, 1, 'forecast called once');
  eq(forecastCalls[0].args.action, 'web_search', 'forecast received tool name as action');
  eq(forecastCalls[0].args.inputs, { query: 'hello' }, 'forecast received params as inputs');
  eq(forecastCalls[0].args.context.source, 'openclaw', 'context tagged source=openclaw');
  ok(events.some((e) => e.type === 'observed' && e.toolName === 'web_search'), 'observed telemetry emitted');
}

console.log('\n[2] enforce + STOP → block:true with blockReason, observe(aborted) fires');
{
  pendingForecasts.clear();
  const { cfg, events, observeCalls } = makeCfg({
    mode: 'enforce',
    forecastResult: {
      id: 'fc_stop',
      recommendation: 'STOP',
      risk_score: 99,
      red_flags: [
        { severity: 'critical', code: 'SQL_NO_WHERE', message: 'deletes the entire table' },
        { severity: 'critical', code: 'IRREVERSIBLE_NO_BACKUP' },
      ],
    },
  });
  const logger = makeLogger();
  const result = await handleBeforeToolCall(
    { toolName: 'run_sql', params: { statement: 'DELETE FROM users' }, toolCallId: 'tc2' },
    cfg,
    logger
  );
  ok(result?.block === true, 'block: true');
  ok(typeof result?.blockReason === 'string' && result.blockReason.includes('run_sql'), 'blockReason names the tool');
  ok(result.blockReason.includes('SQL_NO_WHERE'), 'blockReason includes flag code');
  ok(result.blockReason.includes('99/100'), 'blockReason includes risk score');
  ok(events.some((e) => e.type === 'stop' && e.forecastId === 'fc_stop'), 'stop telemetry emitted');
  // observe is fire-and-forget — give microtasks a chance to flush
  await new Promise((r) => setImmediate(r));
  ok(observeCalls.some((c) => c.forecastId === 'fc_stop' && c.args.outcome_class === 'aborted'), 'observe(aborted) called for the STOP');
  ok(!pendingForecasts.has('tc2'), 'STOP path evicts its pendingForecasts entry (no leak — after_tool_call never fires for a blocked tool)');
}

console.log('\n[3] enforce + CAUTION + cautionAction=approve → requireApproval prompt');
{
  pendingForecasts.clear();
  const { cfg } = makeCfg({
    mode: 'enforce',
    cautionAction: 'approve',
    forecastResult: {
      id: 'fc_caution',
      recommendation: 'CAUTION',
      risk_score: 55,
      red_flags: [{ severity: 'high', code: 'RECIPIENT_UNVERIFIED' }],
    },
  });
  const logger = makeLogger();
  const result = await handleBeforeToolCall(
    { toolName: 'send_email', params: { to: 'x@y.com' }, toolCallId: 'tc3' },
    cfg,
    logger
  );
  ok(result?.requireApproval, 'returns requireApproval');
  ok(!result?.block, 'no hard block on CAUTION');
  ok(result.requireApproval.title.includes('send_email'), 'approval title names the tool');
  ok(result.requireApproval.description.includes('RECIPIENT_UNVERIFIED'), 'approval description includes flag');
  eq(result.requireApproval.severity, 'warning', 'severity is warning');
  eq(result.requireApproval.timeoutMs, 60_000, 'timeout 60s');
  eq(result.requireApproval.timeoutBehavior, 'deny', 'timeout behavior deny');
}

console.log('\n[4] enforce + CAUTION + cautionAction=block → hard block');
{
  pendingForecasts.clear();
  const { cfg } = makeCfg({
    mode: 'enforce',
    cautionAction: 'block',
    forecastResult: { id: 'fc_caut_block', recommendation: 'CAUTION', risk_score: 60, red_flags: [{ code: 'AMBIGUOUS_INTENT' }] },
  });
  const result = await handleBeforeToolCall({ toolName: 'send_msg', params: {}, toolCallId: 'tc4' }, cfg, makeLogger());
  ok(result?.block === true, 'block: true when cautionAction=block');
  ok(result.blockReason.includes('AMBIGUOUS_INTENT'), 'blockReason includes flag');
  ok(!pendingForecasts.has('tc4'), 'CAUTION->block path evicts its pendingForecasts entry (no leak)');
}

console.log('\n[5] enforce + CAUTION + cautionAction=allow → undefined (proceed)');
{
  pendingForecasts.clear();
  const { cfg } = makeCfg({
    mode: 'enforce',
    cautionAction: 'allow',
    forecastResult: { id: 'fc_caut_allow', recommendation: 'CAUTION', risk_score: 40, red_flags: [] },
  });
  const result = await handleBeforeToolCall({ toolName: 'send_msg', params: {}, toolCallId: 'tc5' }, cfg, makeLogger());
  ok(result === undefined, 'undefined when cautionAction=allow');
}

console.log('\n[6] fail-open — forecast network error does NOT block');
{
  pendingForecasts.clear();
  const { cfg, events } = makeCfg({
    mode: 'enforce',
    forecastError: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });
  const logger = makeLogger();
  const result = await handleBeforeToolCall({ toolName: 'run_sql', params: { statement: 'SELECT 1' }, toolCallId: 'tc6' }, cfg, logger);
  ok(result === undefined, 'fail-open returns undefined');
  ok(logger.warnings.some((w) => w.includes('forecast() failed')), 'warning logged');
  ok(events.some((e) => e.type === 'forecast_error'), 'forecast_error telemetry emitted');
}

console.log('\n[6b] enforce + failClosed — forecast error BLOCKS (NemoClaw posture)');
{
  pendingForecasts.clear();
  const { cfg, events } = makeCfg({
    mode: 'enforce',
    failClosed: true,
    forecastError: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });
  const logger = makeLogger();
  const result = await handleBeforeToolCall({ toolName: 'run_sql', params: { statement: 'DELETE FROM users' }, toolCallId: 'tc6b' }, cfg, logger);
  ok(result?.block === true, 'fail-closed blocks the tool call');
  ok(/unreachable/i.test(result?.blockReason ?? ''), 'blockReason explains the gate was unreachable');
  ok(logger.warnings.some((w) => w.includes('FAILING CLOSED')), 'fail-closed warning logged');
  ok(events.some((e) => e.type === 'forecast_error' && e.failedClosed === true), 'forecast_error telemetry marks failedClosed');
}

console.log('\n[6c] observe + failClosed — never blocks (observe is log-only)');
{
  pendingForecasts.clear();
  const { cfg } = makeCfg({ mode: 'observe', failClosed: true, forecastError: new Error('connect ETIMEDOUT') });
  const result = await handleBeforeToolCall({ toolName: 'run_sql', params: {}, toolCallId: 'tc6c' }, cfg, makeLogger());
  ok(result === undefined, 'observe mode never blocks, even with failClosed');
}

console.log('\n[7] shouldGate opt-out — skipped tools never get forecasted');
{
  pendingForecasts.clear();
  const { cfg, events, forecastCalls } = makeCfg({
    mode: 'enforce',
    shouldGate: (name) => name !== 'safe_tool',
  });
  const result = await handleBeforeToolCall({ toolName: 'safe_tool', params: {}, toolCallId: 'tc7' }, cfg, makeLogger());
  ok(result === undefined, 'opt-out returns undefined');
  eq(forecastCalls.length, 0, 'forecast NOT called for opt-out tool');
  ok(events.some((e) => e.type === 'skipped'), 'skipped event emitted');
}

console.log('\n[8] after_tool_call (success) → observe(matched)');
{
  pendingForecasts.clear();
  const { cfg, observeCalls } = makeCfg({ mode: 'enforce' });
  // Seed the pending map as if before_tool_call had run.
  pendingForecasts.set('tc8', { id: 'fc_after_ok', recommendation: 'GO' });
  await handleAfterToolCall(
    { toolName: 'run_sql', params: {}, toolCallId: 'tc8', result: { rows: 5 }, durationMs: 142 },
    cfg,
    makeLogger()
  );
  ok(observeCalls.some((c) => c.forecastId === 'fc_after_ok' && c.args.outcome_class === 'matched'), 'observe called with matched');
  ok(!pendingForecasts.has('tc8'), 'entry cleared after consumption');
}

console.log('\n[9] after_tool_call (error) → observe(diverged) with details');
{
  pendingForecasts.clear();
  const { cfg, observeCalls } = makeCfg({ mode: 'enforce' });
  pendingForecasts.set('tc9', { id: 'fc_after_err' });
  await handleAfterToolCall(
    { toolName: 'web_search', params: {}, toolCallId: 'tc9', error: 'permission denied: foo' },
    cfg,
    makeLogger()
  );
  const call = observeCalls.find((c) => c.forecastId === 'fc_after_err');
  ok(call?.args.outcome_class === 'diverged', 'outcome_class=diverged on error');
  eq(call?.args.divergence_severity, 'medium', 'severity=medium');
  ok(call?.args.details?.includes('permission denied'), 'details forwards error message');
}

console.log('\n[10] truncateInputs — defends against oversized payloads');
{
  const big = { sql: 'X'.repeat(10_000), name: 'short' };
  const trimmed = truncateInputs(big, 1024);
  ok(trimmed._truncated === true, 'flagged _truncated');
  ok(typeof trimmed.sql === 'string' && trimmed.sql.length < 300, 'long string clipped');
  ok(trimmed.name === 'short', 'short fields preserved');
}

console.log('\n[11] BlockReason + ApprovalDescription formatting');
{
  const verdict = {
    id: 'fc_x', recommendation: 'CAUTION', risk_score: 72,
    red_flags: [
      { severity: 'critical', code: 'PROMPT_INJECTION_LIKELY', message: 'instruction in tool output' },
      { severity: 'high', code: 'CROSS_ENVIRONMENT' },
    ],
  };
  const desc = buildApprovalDescription('shell_exec', verdict);
  ok(desc.includes('shell_exec'), 'approval desc includes tool name');
  ok(desc.includes('72/100'), 'approval desc includes risk score');
  ok(desc.includes('PROMPT_INJECTION_LIKELY'), 'approval desc lists top flag');
  const reason = buildBlockReason('shell_exec', { ...verdict, recommendation: 'STOP' });
  ok(reason.startsWith('BLACK_WALL blocked tool "shell_exec"'), 'block reason starts with branded prefix');
  ok(reason.includes('PROMPT_INJECTION_LIKELY'), 'block reason includes flag');
}

console.log('\n[12] missing toolName → no-op without error');
{
  pendingForecasts.clear();
  const { cfg, forecastCalls } = makeCfg({ mode: 'enforce' });
  const result = await handleBeforeToolCall({ params: {} }, cfg, makeLogger());
  ok(result === undefined, 'undefined when toolName missing');
  eq(forecastCalls.length, 0, 'forecast not called');
}

console.log('\n[13] apiKey resolves from a FILE when env is absent (sandboxed runtimes, e.g. NemoClaw)');
{
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bw-key-'));
  const keyFile = join(dir, 'blackwall.key');
  writeFileSync(keyFile, '  bw_live_FROMFILE0001  \n');
  const savedKey = process.env.BLACKWALL_API_KEY;
  const savedFile = process.env.BLACKWALL_API_KEY_FILE;
  delete process.env.BLACKWALL_API_KEY;
  process.env.BLACKWALL_API_KEY_FILE = keyFile;
  try {
    eq(resolveConfig({}).apiKey, 'bw_live_FROMFILE0001', 'apiKey read + trimmed from BLACKWALL_API_KEY_FILE');
    eq(resolveConfig({ apiKey: 'bw_live_CFG' }).apiKey, 'bw_live_CFG', 'config.apiKey takes precedence over the file');
    process.env.BLACKWALL_API_KEY = 'bw_live_ENV';
    eq(resolveConfig({}).apiKey, 'bw_live_ENV', 'env takes precedence over the file');
    delete process.env.BLACKWALL_API_KEY;
    process.env.BLACKWALL_API_KEY_FILE = join(dir, 'does-not-exist.key');
    eq(resolveConfig({}).apiKey, undefined, 'missing key file → undefined (no throw)');
  } finally {
    if (savedKey === undefined) delete process.env.BLACKWALL_API_KEY; else process.env.BLACKWALL_API_KEY = savedKey;
    if (savedFile === undefined) delete process.env.BLACKWALL_API_KEY_FILE; else process.env.BLACKWALL_API_KEY_FILE = savedFile;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================

console.log(`\n${passed} passed · ${failed} failed`);
if (failed > 0) {
  console.error('\nSmoke tests FAILED.');
  process.exit(1);
} else {
  console.log('\nAll smoke tests passed.');
}
