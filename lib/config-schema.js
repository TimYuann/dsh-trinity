// lib/config-schema.js — zod schema for the web-access-chain settings namespace.
//
// SPEC §II.4 — the only normative schema for v2.1 configuration. Registered
// into ctx.settings under the namespace 'web-access-chain'. We use
// @deepseek-ai/schemastery (already a dependency) so the schema declaration
// matches the rest of the DSH ecosystem.
//
// v2.1: the `legacyImportVersion` + `legacyImportConflicts` fields were
// removed (legacy-import path was dropped entirely; see SPEC v2.1
// release notes).
//
// v2.2: namespace renamed 'webAccessChain' → 'web-access-chain' to satisfy
// the settings seam's namespace grammar /^[a-z][a-z0-9-]*$/ (lowercase
// kebab-case). Persisted settings were migrated by the installer docs.

import z from '@deepseek-ai/schemastery'

export const SETTINGS_NAMESPACE = 'web-access-chain'

/**
 * The full v2.0 settings schema. Every default lives here so the plugin's
 * downstream modules can rely on `settings.get('web-access-chain')` returning
 * a fully-populated object after registration.
 *
 * The `maxInlineContentChars` field is INTENTIONALLY ABSENT — SPEC §II.3.4
 * says it is DSH's toolResultPruner concern, not this plugin's. We do not
 * duplicate it.
 */
export const WebAccessChainSchema = z.object({
  // ── Routing ──────────────────────────────────────────────────────
  routing: z.union(['auto', 'aggregate']).default('auto'),
  // Note: 'single' and ordered lists live in the Tool param `routing`,
  // not in global config (SPEC §II.4 explicit note).

  // ── Self-hosted SearXNG (optional; also read from $SEARXNG_HOST) ─
  searxngHost: z.union([z.string(), z.const(null)]).default(null),

  // ── Runtime budgets (SPEC §I.9) ─────────────────────────────────
  searchTotalTimeoutMs: z.number().min(1000).max(120000).default(30000),
  perProviderTimeoutMs: z.number().min(500).max(60000).default(8000),
  perKeyTimeoutMs: z.number().min(500).max(60000).default(8000),
  maxProvidersPerSearch: z.number().min(1).max(25).default(18),
  maxKeysPerProvider: z.number().min(1).max(10).default(3),
  aggregateMaxFanout: z.number().min(1).max(8).default(4),

  // ── Cache (SPEC §II.3.4) ─────────────────────────────────────────
  cacheTtlMs: z.number().min(0).default(60 * 60 * 1000),
  cacheMaxEntries: z.number().min(1).default(128),
  cacheMaxBytes: z.number().min(1).default(128 * 1024 * 1024),

  // ── Fetch policy (SPEC §II.4) ───────────────────────────────────
  fetchRoutingMode: z.union(['http-only']).default('http-only'),
  fetchMaxResponseMB: z.number().min(1).max(50).default(5),
  ssrf: z.object({
    allowRanges: z.array(z.string()).default([]),
    trustEnvProxy: z.boolean().default(false),
  }).default({ allowRanges: [], trustEnvProxy: false }),
  proxy: z.union([z.string(), z.const(null)]).default(null),
  domainPolicy: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({ allow: [], deny: [] }),

  // ── Authenticated fetch profiles (SPEC §II.4) ───────────────────
  authFetch: z.dict(z.object({
    type: z.union(['bearer', 'basic', 'cookie']),
    valueRef: z.string(),
    allowedOrigins: z.array(z.string()),
  })).default({}),

  // ── Adapter gates (whether the adapter exists in safeFetch) ─────
  adapters: z.object({
    github: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    youtube: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    rss: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    pdf: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    genericHtml: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  }).default({}),

  // ── Tool gates (whether the standalone Tool is registered) ───────
  tools: z.object({
    githubPrIssue: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    videoExtract: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    pdfExtract: z.object({
      enabled: z.boolean().default(false),
      maxPages: z.union([z.number(), z.const(null)]).default(null),
      provider: z.union(['unpdf', 'datalab', 'gemini']).default('unpdf'),
    }).default({ enabled: false, maxPages: null, provider: 'unpdf' }),
  }).default({}),

  // ── source_check (SPEC §II.5) ───────────────────────────────────
  sourceCheck: z.object({
    enabled: z.boolean().default(true),
    subQueryCount: z.number().min(1).max(6).default(3),
    maxPagesFetch: z.number().min(1).max(10).default(5),
    topPassagesPerSource: z.number().min(1).max(10).default(3),
    assessmentModel: z.union([z.string(), z.const(null)]).default(null),
  }).default({}),

  // ── v1 carry-over: mmx subprocess fallback (Commit 1 stability) ─
  mmxFallback: z.boolean().default(true),
})

/**
 * The list of provider ids that appear in the auto chain. Order matters —
 * this is the literal sequence the chain visits (SPEC §II.3.3 Provider
 * Chain). SearXNG is prepended at apply() time when `searxngHost` is set;
 * mmx is appended as the local fallback when `mmxFallback: true`.
 */
export const AUTO_CHAIN_PROVIDERS = [
  'searxng', 'openai', 'exa', 'brave', 'parallel', 'tinyfish', 'search1api',
  'searchinfinity', 'querit', 'tavily', 'firecrawl', 'jina', 'serpdive',
  'kagi', 'bocha', 'ollama', 'perplexity', 'gemini',
]

export const EXPLICIT_ONLY_PROVIDERS = [
  'duckduckgo', 'anysearch', 'xai', 'brightdata', 'serpbase', 'serper', 'valyu',
  'kimi', 'parallelMcp',
]

export const ALL_PROVIDER_IDS = [...AUTO_CHAIN_PROVIDERS, ...EXPLICIT_ONLY_PROVIDERS]

/**
 * Credential slot count per provider (how many `<provider>.N` slots to
 * probe). The pool machinery (lib/credentials/pool.js) reads this list to
 * decide which keys to construct a CredentialEntry[] for.
 */
export const CREDENTIAL_SLOTS_PER_PROVIDER = 3
