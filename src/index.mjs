/**
 * blackwall-openclaw-plugin
 * -------------------------
 * Thin SDK wrapper. Registers `before_tool_call` + `after_tool_call` hooks
 * with OpenClaw and delegates all gating logic to ./gate.mjs (which is
 * importable without the openclaw peer dep for unit testing).
 *
 * Architecture rationale: OpenClaw's plugin SDK exposes `before_tool_call` as
 * an official typed hook with `block` + `requireApproval` return semantics —
 * exactly the shape a pre-action guardrail needs. We do not monkey-patch the
 * dispatcher; we use the framework's documented extension surface.
 *
 * Spec references:
 *   - https://docs.openclaw.ai/plugins/hooks (before_tool_call catalog entry)
 *   - https://blackwalltier.com (forecast / observe API)
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  resolveConfig,
  handleBeforeToolCall,
  handleAfterToolCall,
  emit,
} from './gate.mjs';

/**
 * Plugin factory.
 *
 * Usage:
 *   // ~/.openclaw/openclaw.json
 *   { "plugins": { "entries": { "blackwall-openclaw-plugin": { "enabled": true } } } }
 *
 *   // env
 *   BLACKWALL_API_KEY=bw_live_...
 *   BLACKWALL_MODE=enforce            # or 'observe' (default)
 *
 * @param {import('./gate.mjs').BlackwallOpenClawConfig} [config]
 */
export function createBlackwallPlugin(config = {}) {
  return definePluginEntry({
    id: 'blackwall-openclaw-plugin',
    name: 'BLACK_WALL Preflight Guardrail',
    description:
      'Pre-action risk check for OpenClaw tool calls. Hooks before_tool_call to ' +
      'call BLACK_WALL forecast(); in enforce mode, blocks STOP verdicts and ' +
      'surfaces CAUTION as approval prompts. Receipts are Ed25519-signed and ' +
      'verifiable offline.',
    register(api) {
      const cfg = resolveConfig(config);
      const logger = api?.logger ?? console;

      if (!cfg.apiKey) {
        logger.warn?.(
          '[blackwall] No apiKey configured. Set BLACKWALL_API_KEY or pass { apiKey } to createBlackwallPlugin(). ' +
            'Plugin will load but every forecast() call will fail and the hook will fall through (fail-open).'
        );
      }
      emit(cfg.onEvent, { type: 'register', extra: { mode: cfg.mode, cautionAction: cfg.cautionAction } });

      api.on(
        'before_tool_call',
        (event /* , ctx */) => handleBeforeToolCall(event, cfg, logger),
        { priority: 80, timeoutMs: cfg.forecastTimeoutMs }
      );

      api.on(
        'after_tool_call',
        (event /* , ctx */) => handleAfterToolCall(event, cfg, logger),
        { priority: 80 }
      );
    },
  });
}

// Default export: pre-constructed plugin reading config from env. Most installs
// just list this package; everything else is environment-driven.
export default createBlackwallPlugin();
