#!/usr/bin/env node
/**
 * Real-OpenClaw test — imports the actual openclaw plugin SDK and verifies
 * the plugin entry has the shape OpenClaw expects.
 *
 * Run after `npm install` so the openclaw peer-dep is resolvable.
 */

import { createBlackwallPlugin } from './src/index.mjs';
import blackwallDefault from './src/index.mjs';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { console.log(`  ok — ${l}`); passed++; } else { console.error(`  FAIL — ${l}`); failed++; } }

console.log('\n[1] createBlackwallPlugin() returns a plugin entry');
{
  const p = createBlackwallPlugin({ apiKey: 'bw_live_test' });
  ok(p && typeof p === 'object', 'plugin entry is an object');
  ok(typeof p.id === 'string' && p.id === 'blackwall-openclaw-plugin', `id="${p.id}"`);
  ok(typeof p.name === 'string' && p.name.includes('BLACK_WALL'), `name="${p.name}"`);
  ok(typeof p.description === 'string' && p.description.length > 20, 'description present');
  ok(typeof p.register === 'function', 'register is a function');
}

console.log('\n[2] default export is a pre-constructed plugin');
{
  ok(blackwallDefault && typeof blackwallDefault === 'object', 'default export is an object');
  ok(typeof blackwallDefault.register === 'function', 'default export.register is a function');
  ok(blackwallDefault.id === 'blackwall-openclaw-plugin', 'default export id correct');
}

console.log('\n[3] register(api) wires before_tool_call + after_tool_call');
{
  // Build a fake `api` object that records hook registrations.
  const handlers = new Map();
  const api = {
    on(name, handler, opts) {
      handlers.set(name, { handler, opts });
    },
    logger: { warn: () => {} },
  };
  const plugin = createBlackwallPlugin({ apiKey: 'bw_live_test' });
  plugin.register(api);
  ok(handlers.has('before_tool_call'), 'before_tool_call registered');
  ok(handlers.has('after_tool_call'), 'after_tool_call registered');
  const beforeReg = handlers.get('before_tool_call');
  ok(typeof beforeReg.opts?.priority === 'number', 'before_tool_call has priority');
  ok(typeof beforeReg.opts?.timeoutMs === 'number', 'before_tool_call has timeoutMs');
}

console.log('\n[4] Missing apiKey logs a warning but does not throw');
{
  const warnings = [];
  const api = { on() {}, logger: { warn: (m) => warnings.push(String(m)) } };
  delete process.env.BLACKWALL_API_KEY;
  const p = createBlackwallPlugin();
  p.register(api);
  ok(warnings.some((w) => w.includes('No apiKey')), 'warned about missing apiKey');
}

console.log(`\n${passed} passed · ${failed} failed`);
if (failed > 0) process.exit(1);
