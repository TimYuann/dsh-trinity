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
// Every knob below is marked `.volatile()` on purpose. On DSH >= 0.1.7 the
// `settings` service only exposes fields under a volatile node to the native
// settings form (`describe` / `update` / `mutate`), and only those paths can
// be written back to the profile patch. `authFetch` is deliberately NOT
// volatile: it holds credential REFERENCES and origin allowlists, which stay
// out of the generated form (and are managed by the plugin's own control
// center / `/webdoctor-keys`).
//
// Volatility is safe here because the Loader restarts this plugin's fiber on
// a config edit (dispose + re-apply), so every registration is rebuilt from
// the new resolved Config.
export const WebAccessChainSchema = z.object({
  // ── Routing ──────────────────────────────────────────────────────
  routing: z.union(['auto', 'aggregate']).default('auto').volatile(),
  // Note: 'single' and ordered lists live in the Tool param `routing`,
  // not in global config (SPEC §II.4 explicit note).

  // ── Self-hosted SearXNG (optional; also read from $SEARXNG_HOST) ─
  searxngHost: z.union([z.string(), z.const(null)]).default(null).volatile(),

  // ── Runtime budgets (SPEC §I.9) ─────────────────────────────────
  searchTotalTimeoutMs: z.number().min(1000).max(120000).default(30000).volatile(),
  perProviderTimeoutMs: z.number().min(500).max(60000).default(8000).volatile(),
  perKeyTimeoutMs: z.number().min(500).max(60000).default(8000).volatile(),
  maxProvidersPerSearch: z.number().min(1).max(25).default(18).volatile(),
  maxKeysPerProvider: z.number().min(1).max(10).default(3).volatile(),
  aggregateMaxFanout: z.number().min(1).max(8).default(4).volatile(),

  // ── Cache (SPEC §II.3.4) ─────────────────────────────────────────
  cacheTtlMs: z.number().min(0).default(60 * 60 * 1000).volatile(),
  cacheMaxEntries: z.number().min(1).default(128).volatile(),
  cacheMaxBytes: z.number().min(1).default(128 * 1024 * 1024).volatile(),

  // ── Fetch policy (SPEC §II.4) ───────────────────────────────────
  fetchRoutingMode: z.union(['http-only']).default('http-only').volatile(),
  fetchMaxResponseMB: z.number().min(1).max(50).default(5).volatile(),
  ssrf: z.object({
    allowRanges: z.array(z.string()).default([]).volatile(),
    trustEnvProxy: z.boolean().default(false).volatile(),
  }).default({ allowRanges: [], trustEnvProxy: false }),
  proxy: z.union([z.string(), z.const(null)]).default(null).volatile(),
  domainPolicy: z.object({
    allow: z.array(z.string()).default([]).volatile(),
    deny: z.array(z.string()).default([]).volatile(),
  }).default({ allow: [], deny: [] }),

  // ── Authenticated fetch profiles (SPEC §II.4) ───────────────────
  // NOT volatile: credential references are never surfaced in the native
  // settings form (see the note above).
  authFetch: z.dict(z.object({
    type: z.union(['bearer', 'basic', 'cookie']),
    valueRef: z.string(),
    allowedOrigins: z.array(z.string()),
  })).default({}),

  // ── Adapter gates (whether the adapter exists in safeFetch) ─────
  adapters: z.object({
    github: z.object({ enabled: z.boolean().default(true).volatile() }).default({ enabled: true }),
    youtube: z.object({ enabled: z.boolean().default(true).volatile() }).default({ enabled: true }),
    rss: z.object({ enabled: z.boolean().default(true).volatile() }).default({ enabled: true }),
    pdf: z.object({ enabled: z.boolean().default(true).volatile() }).default({ enabled: true }),
    genericHtml: z.object({ enabled: z.boolean().default(true).volatile() }).default({ enabled: true }),
  }).default({}),

  // ── Tool gates (whether the standalone Tool is registered) ───────
  tools: z.object({
    githubPrIssue: z.object({ enabled: z.boolean().default(false).volatile() }).default({ enabled: false }),
    videoExtract: z.object({ enabled: z.boolean().default(false).volatile() }).default({ enabled: false }),
    pdfExtract: z.object({
      enabled: z.boolean().default(false).volatile(),
      maxPages: z.union([z.number(), z.const(null)]).default(null).volatile(),
      provider: z.union(['unpdf', 'datalab', 'gemini']).default('unpdf').volatile(),
    }).default({ enabled: false, maxPages: null, provider: 'unpdf' }),
  }).default({}),

  // ── source_check (SPEC §II.5) ───────────────────────────────────
  sourceCheck: z.object({
    enabled: z.boolean().default(true).volatile(),
    subQueryCount: z.number().min(1).max(6).default(3).volatile(),
    maxPagesFetch: z.number().min(1).max(10).default(5).volatile(),
    topPassagesPerSource: z.number().min(1).max(10).default(3).volatile(),
    assessmentModel: z.union([z.string(), z.const(null)]).default(null).volatile(),
  }).default({}),

  // ── v1 carry-over: mmx subprocess fallback (Commit 1 stability) ─
  mmxFallback: z.boolean().default(true).volatile(),
})

/**
 * The list of provider ids that appear in the auto chain. Order matters —
 * this is the literal sequence the chain visits (SPEC §II.3.3 Provider
 * Chain). SearXNG is prepended at apply() time when `searxngHost` is set;
 * mmx is appended as the local fallback when `mmxFallback: true`.
 */
export const AUTO_CHAIN_PROVIDERS = [
  'searxng', 'exa', 'brave', 'parallel', 'tinyfish', 'search1api',
  'searchinfinity', 'querit', 'tavily', 'firecrawl', 'jina', 'serpdive',
  'kagi', 'bocha', 'ollama', 'perplexity', 'gemini', 'anysearch',
]

export const EXPLICIT_ONLY_PROVIDERS = [
  'duckduckgo', 'xai', 'brightdata', 'serpbase', 'serper', 'valyu',
  'kimi', 'parallelMcp',
]

export const ALL_PROVIDER_IDS = [...AUTO_CHAIN_PROVIDERS, ...EXPLICIT_ONLY_PROVIDERS]

/**
 * Credential slot count per provider (how many `<provider>.N` slots to
 * probe). The pool machinery (lib/credentials/pool.js) reads this list to
 * decide which keys to construct a CredentialEntry[] for.
 */
export const CREDENTIAL_SLOTS_PER_PROVIDER = 3
