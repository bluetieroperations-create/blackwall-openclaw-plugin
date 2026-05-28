/**
 * Pure gating logic — no OpenClaw SDK import. Testable in isolation.
 *
 * The SDK wrapper at ./index.mjs registers `before_tool_call` and
 * `after_tool_call` hooks; both delegate to the functions here, which is
 * everything the unit tests exercise.
 */

import { forecast as defaultForecast, observe as defaultObserve } from 'blackwall-mcp/lib';

const DEFAULT_MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_FORECAST_TIMEOUT_MS = 15_000;

/**
 * Map of toolCallId / runId-keyed entry -> forecast verdict. Module-scoped so
 * before_tool_call and after_tool_call share state. Bounded — entries are
 * deleted as soon as after_tool_call consumes them.
 */
export const pendingForecasts = new Map();

export function resolveConfig(config = {}) {
  const mode = (config.mode ?? process.env.BLACKWALL_MODE ?? 'observe').toLowerCase();
  const cautionAction = (config.cautionAction ?? 'approve').toLowerCase();
  return {
    apiKey: config.apiKey ?? process.env.BLACKWALL_API_KEY,
    baseUrl: config.baseUrl ?? process.env.BLACKWALL_BASE_URL,
    mode: mode === 'enforce' ? 'enforce' : 'observe',
    cautionAction: ['block', 'approve', 'allow'].includes(cautionAction) ? cautionAction : 'approve',
    shouldGate: typeof config.shouldGate === 'function' ? config.shouldGate : () => true,
    maxInputBytes: typeof config.maxInputBytes === 'number' ? config.maxInputBytes : DEFAULT_MAX_INPUT_BYTES,
    forecastTimeoutMs: typeof config.forecastTimeoutMs === 'number' ? config.forecastTimeoutMs : DEFAULT_FORECAST_TIMEOUT_MS,
    onEvent: typeof config.onEvent === 'function' ? config.onEvent : null,
    // Injectable forecast/observe so tests can mock without a Node loader.
    forecast: typeof config.forecast === 'function' ? config.forecast : defaultForecast,
    observe: typeof config.observe === 'function' ? config.observe : defaultObserve,
  };
}

export function truncateInputs(inputs, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(inputs);
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
  if (serialized.length <= maxBytes) return inputs;

  if (Array.isArray(inputs)) {
    return { _truncated: true, _length: inputs.length, _byteSize: serialized.length };
  }
  if (typeof inputs !== 'object' || inputs === null) {
    return { _truncated: true, _byteSize: serialized.length };
  }
  const trimmed = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && v.length > 200) {
      trimmed[k] = `${v.slice(0, 200)}…<truncated ${v.length} chars>`;
    } else {
      trimmed[k] = v;
    }
  }
  trimmed._truncated = true;
  trimmed._original_bytes = serialized.length;
  return trimmed;
}

export function emit(onEvent, event) {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* swallow telemetry errors — never break the hook */
  }
}

export function buildApprovalDescription(toolName, verdict) {
  const flags = Array.isArray(verdict?.red_flags) ? verdict.red_flags : [];
  const topFlags = flags
    .slice(0, 5)
    .map((f) => `• ${f?.severity?.toUpperCase?.() ?? 'flag'}: ${f?.code ?? 'unknown'}${f?.message ? ` — ${f.message}` : ''}`)
    .join('\n');
  const risk = typeof verdict?.risk_score === 'number' ? ` risk ${verdict.risk_score}/100` : '';
  const tail = flags.length > 5 ? `\n…and ${flags.length - 5} more` : '';
  return `BLACK_WALL flagged "${toolName}" as CAUTION${risk}.\n\n${topFlags || '(no specific red flags surfaced)'}${tail}\n\nAllow this tool call to proceed?`;
}

export function buildBlockReason(toolName, verdict) {
  const flagCodes = Array.isArray(verdict?.red_flags)
    ? verdict.red_flags.map((f) => f?.code).filter(Boolean).slice(0, 3).join(', ')
    : '';
  const risk = typeof verdict?.risk_score === 'number' ? ` (risk ${verdict.risk_score}/100)` : '';
  return `BLACK_WALL blocked tool "${toolName}"${risk}${flagCodes ? `: ${flagCodes}` : ''}`;
}

function keyFor(event) {
  if (event?.toolCallId) return event.toolCallId;
  if (event?.runId && event?.toolName) return `run:${event.runId}:${event.toolName}`;
  return null;
}

/**
 * Handle a `before_tool_call` event. Returns the same shape OpenClaw's
 * PluginHookBeforeToolCallResult expects:
 *   { block?: boolean, blockReason?: string, requireApproval?: {...} } | undefined
 *
 * @param {*} event   the OpenClaw before_tool_call event
 * @param {*} cfg     resolved config (from resolveConfig())
 * @param {*} logger  a logger with at least .warn(); defaults to console
 */
export async function handleBeforeToolCall(event, cfg, logger = console) {
  const toolName = event?.toolName;
  if (!toolName) return undefined;
  if (!cfg.shouldGate(toolName)) {
    emit(cfg.onEvent, { type: 'skipped', toolName, extra: { reason: 'opt-out' } });
    return undefined;
  }

  const rawParams = event?.params ?? {};
  const inputs = truncateInputs(rawParams, cfg.maxInputBytes);
  const context = {
    source: 'openclaw',
    ...(event?.toolKind ? { tool_kind: event.toolKind } : {}),
    ...(event?.toolInputKind ? { tool_input_kind: event.toolInputKind } : {}),
    ...(Array.isArray(event?.derivedPaths) && event.derivedPaths.length
      ? { derived_paths: event.derivedPaths.slice(0, 10) }
      : {}),
  };

  let verdict;
  try {
    verdict = await cfg.forecast(
      { action: toolName, inputs, context },
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }
    );
  } catch (err) {
    // Fail-open: BW outage must NEVER block the agent.
    logger.warn?.(`[blackwall] forecast() failed for tool "${toolName}" — proceeding without gate: ${err?.message ?? err}`);
    emit(cfg.onEvent, { type: 'forecast_error', toolName, error: err });
    return undefined;
  }

  // Stash for after_tool_call to consume.
  const k = keyFor(event);
  if (k && verdict?.id) pendingForecasts.set(k, verdict);

  const recommendation = verdict?.recommendation;

  // observe mode: never abort, just score + log.
  if (cfg.mode === 'observe') {
    emit(cfg.onEvent, { type: 'observed', toolName, forecastId: verdict?.id, recommendation });
    return undefined;
  }

  // enforce mode: STOP -> hard block
  if (recommendation === 'STOP') {
    emit(cfg.onEvent, { type: 'stop', toolName, forecastId: verdict?.id, recommendation });
    if (verdict?.id) {
      // Fire-and-forget observe(aborted). Don't await — the block must hit the
      // dispatcher promptly.
      cfg.observe(
        verdict.id,
        { outcome_class: 'aborted', divergence_severity: 'none', details: 'blocked by enforce-mode guardrail' },
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: 'openclaw_plugin' }
      ).catch((err) => {
        logger.warn?.(`[blackwall] observe(aborted) failed: ${err?.message ?? err}`);
        emit(cfg.onEvent, { type: 'observe_error', toolName, forecastId: verdict.id, error: err });
      });
    }
    return {
      block: true,
      blockReason: buildBlockReason(toolName, verdict),
    };
  }

  // enforce mode: CAUTION -> configurable
  if (recommendation === 'CAUTION') {
    if (cfg.cautionAction === 'allow') return undefined;
    if (cfg.cautionAction === 'block') {
      emit(cfg.onEvent, { type: 'stop', toolName, forecastId: verdict?.id, recommendation });
      return { block: true, blockReason: buildBlockReason(toolName, verdict) };
    }
    emit(cfg.onEvent, { type: 'require_approval', toolName, forecastId: verdict?.id, recommendation });
    return {
      requireApproval: {
        title: `BLACK_WALL: tool "${toolName}" flagged CAUTION`,
        description: buildApprovalDescription(toolName, verdict),
        severity: 'warning',
        timeoutMs: 60_000,
        timeoutBehavior: 'deny',
        pluginId: 'blackwall',
      },
    };
  }

  // GO -> proceed.
  return undefined;
}

/**
 * Handle an `after_tool_call` event. Looks up the paired forecast verdict and
 * reports the actual outcome via observe(). Returns void (after-hooks are
 * observational only).
 *
 * @param {*} event   the OpenClaw after_tool_call event
 * @param {*} cfg     resolved config (from resolveConfig())
 * @param {*} logger  a logger with at least .warn(); defaults to console
 */
export async function handleAfterToolCall(event, cfg, logger = console) {
  const toolName = event?.toolName;
  if (!toolName) return;
  const k = keyFor(event);
  if (!k) return;
  const verdict = pendingForecasts.get(k);
  if (!verdict?.id) return;
  pendingForecasts.delete(k);

  const hadError = typeof event?.error === 'string' && event.error.length > 0;
  const outcomeClass = hadError ? 'diverged' : 'matched';
  const details = hadError ? String(event.error).slice(0, 500) : undefined;

  try {
    await cfg.observe(
      verdict.id,
      {
        outcome_class: outcomeClass,
        ...(hadError ? { divergence_severity: 'medium', details } : {}),
        ...(typeof event?.durationMs === 'number' ? { actual_targets: [`duration_ms:${event.durationMs}`] } : {}),
      },
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: 'openclaw_plugin' }
    );
    emit(cfg.onEvent, { type: 'observed_outcome', toolName, forecastId: verdict.id, extra: { outcomeClass } });
  } catch (err) {
    logger.warn?.(`[blackwall] observe(${outcomeClass}) failed: ${err?.message ?? err}`);
    emit(cfg.onEvent, { type: 'observe_error', toolName, forecastId: verdict.id, error: err });
  }
}
