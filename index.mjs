// Root plugin entry.
// OpenClaw's plugin loader resolves the entry module from the manifest root via
// DEFAULT_PLUGIN_ENTRY_CANDIDATES = ["index.ts","index.js","index.mjs","index.cjs"].
// The implementation lives in ./src/index.mjs (kept there so gate.mjs stays
// importable without the openclaw peer dep for unit tests); this root shim is
// what OpenClaw 2026.4.x discovers and imports as the openclaw-format entry.
export { default, createBlackwallPlugin } from './src/index.mjs';
