// lib/tool-guidance.js — single system-prompt section per SPEC §I.7.
//
// No per-turn injection of doctor state. Doctor hints appear only inside
// the error result that triggered them.
//
// v2.1: guidance flipped to prefer this plugin's tools over the DSH
// built-in `web_search` / `web_fetch`. The DSH built-ins also route
// through this plugin's chain (via the configured namespaced
// search/fetch providers in cordis.patch.yml), but they are thin
// wrappers around a single provider and do NOT expose routing,
// AI-synthesised answers, or specialised adapters.

export const SECTION_NAME = 'dsh-web-search-chained:tool-guidance'

export const TOOL_GUIDANCE = [
  '# DSH Trinity — 联网研究工具',
  '',
  '进行联网研究时，优先使用 DSH Trinity 提供的工具。本插件保留 DSH 原生工具，并在底层路由到多 Provider。',
  'DSH built-in `web_search` / `web_fetch` are also routed through this plugin\'s',
  'chain (via the configured namespaced search/fetch providers), but they are',
  'thin wrappers around a single provider and do NOT expose the routing/output',
  'features below.',
  '',
  'Preferred entry points (DSH will run them through this plugin\'s chain):',
  '',
  '- `web_search_ex(query or queries, routing?, output?)` — full control.',
  '  - `routing: "auto"` (default) picks the best provider from the pool.',
  '  - `routing: "aggregate"` runs multiple providers in parallel and merges.',
  '  - `routing: ["<provider1>", "<provider2>", ...]` — runs them in order, stopping at the first success.',
  '  - `routing: "<provider>"` (bare string, no array) — pins one provider, single call, no fallback.',
  '  - `output: "answer"` returns an AI-synthesized answer; `output: "sources"`',
  '    returns the raw sources list (default).',
  '- `search_content(cacheRef)` — read back a cached payload snapshot by',
  '  cacheRef (cacheRefs come from source_check evidenceSnapshotRefs;',
  '  web_search_ex / web_fetch do NOT produce them). Supports offset/limit',
  '  slicing and findText passage search.',
  '- `source_check(claim, sources?)` — verify whether a claim is supported by',
  '  the given or fetched sources.',
  '- `web_doctor()` — diagnose providers, credentials, adapters, cache, proxy.',
  '  Call this when a search/fetch fails or returns empty.',
  '',
  'The DSH built-in `web_search` is acceptable for a single quick query, but',
  'prefer `web_search_ex` when you need richer behavior. For URLs, use the',
  'DSH built-in `web_fetch` (or `search_content` on a source_check snapshot).',
  '',
  'If a tool returns an empty `sources` or a `WEB_SEARCH_CHAIN_EXHAUSTED` /',
  '`WEB_FETCH_FAILED`, call `web_doctor` before retrying with a different query.',
  '',
  '## Configuring API keys',
  '',
  'Keys live in DSH\'s encrypted credential store, never in any plugin-external',
  'config file. Configure with:',
  '',
  '  /webdoctor-keys set <provider> <key>',
  '  /webdoctor-keys list',
  '  /webdoctor-keys clear <provider>',
  '  /webdoctor-keys test <provider>',
  '',
  'Or for server deployments, set the environment variable directly:',
  '`EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, etc. (env wins over the',
  'credential store; see README for the full provider list).',
].join('\n')
