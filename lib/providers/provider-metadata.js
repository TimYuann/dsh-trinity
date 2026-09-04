// lib/providers/provider-metadata.js — single canonical Provider metadata
// source (v2.3.0 § Commit 4).
//
// Every other subsystem (UI, /webdoctor-keys, pool credential refs,
// fallback env names) consumes this table. The fix the review named:
//
//   - Firecrawl  : one canonical ref `FIRECRAWL_API_KEY`; the legacy
//                  `FIRECRAWL_KEY` spelling is a read-only alias.
//   - DuckDuckGo : credential mode 'none' — no API key field. UI shows
//                  no input.
//   - SearXNG    : credential mode 'host'; no API key (searxngHost).
//   - parallelMcp: one canonical ref `PARALLEL_MCP_API_KEY`. The legacy
//                  `PARALLELMCP_API_KEY` spelling is a read-only alias.
//
// The Provider id set feeds `select-routing.js`'s knownIds check so
// chainedSearch rejects unknown ids with WEB_PROVIDER_BAD_REQUEST.
//
// This module is intentionally small: endpoint URLs, model choices, and
// any per-provider knobs remain in the provider module (lib/providers
// /search/<id>.js). Only what every subsystem has to know lives here.

import { AUTO_CHAIN_PROVIDERS, EXPLICIT_ONLY_PROVIDERS, ALL_PROVIDER_IDS } from '../config-schema.js'

/**
 * @typedef {{
 *   id: string,
 *   autoEligible: boolean,
 *   credential: {
 *     mode: 'api-key' | 'host' | 'none',
 *     canonicalRef: string,
 *     aliases?: string[],
 *     maxSlots: number,
 *   },
 *   showInCredentialUi: boolean,
 * }} ProviderMetadata
 */

/**
 * Canonical provider metadata. Order is irrelevant at lookup time; the
 * consumer iterates as a Map. UI consumer displays these rows in
 * declared order for stability.
 *
 * @type {ProviderMetadata[]}
 */
export const PROVIDER_METADATA = [
  // Self-hosted SearXNG — host, no API key.
  {
    id: 'searxng',
    autoEligible: true,
    credential: { mode: 'host', canonicalRef: 'SEARXNG_HOST', maxSlots: 1 },
    showInCredentialUi: false,
  },
  // Paid / per-provider API keys.
  { id: 'openai',     autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'OPENAI_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  { id: 'exa',        autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'EXA_API_KEY',        maxSlots: 3 }, showInCredentialUi: true },
  { id: 'brave',      autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'BRAVE_API_KEY',      maxSlots: 3 }, showInCredentialUi: true },
  { id: 'parallel',   autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'PARALLEL_API_KEY',   maxSlots: 3 }, showInCredentialUi: true },
  { id: 'tinyfish',   autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'TINYFISH_API_KEY',   maxSlots: 3 }, showInCredentialUi: true },
  { id: 'search1api', autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'SEARCH1API_API_KEY', maxSlots: 3 }, showInCredentialUi: true },
  { id: 'searchinfinity', autoEligible: true, credential: { mode: 'api-key', canonicalRef: 'SEARCHINFINITY_API_KEY', maxSlots: 3 }, showInCredentialUi: true },
  { id: 'querit',     autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'QUERIT_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  { id: 'tavily',     autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'TAVILY_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  {
    id: 'firecrawl',
    autoEligible: true,
    // Legacy `FIRECRAWL_KEY` spelling stays an alias for read-time
    // migration. UI writes only the canonical name.
    credential: { mode: 'api-key', canonicalRef: 'FIRECRAWL_API_KEY', aliases: ['FIRECRAWL_KEY'], maxSlots: 3 },
    showInCredentialUi: true,
  },
  { id: 'jina',       autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'JINA_API_KEY',       maxSlots: 3 }, showInCredentialUi: true },
  { id: 'serpdive',   autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'SERPDIVE_API_KEY',   maxSlots: 3 }, showInCredentialUi: true },
  { id: 'kagi',       autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'KAGI_API_KEY',       maxSlots: 3 }, showInCredentialUi: true },
  { id: 'bocha',      autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'BOCHA_API_KEY',      maxSlots: 3 }, showInCredentialUi: true },
  { id: 'ollama',     autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'OLLAMA_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  { id: 'perplexity', autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'PERPLEXITY_API_KEY', maxSlots: 3 }, showInCredentialUi: true },
  { id: 'gemini',     autoEligible: true,  credential: { mode: 'api-key', canonicalRef: 'GEMINI_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  // No-key providers. UI hides them.
  { id: 'duckduckgo', autoEligible: false, credential: { mode: 'none',   canonicalRef: '',                  maxSlots: 0 }, showInCredentialUi: false },
  { id: 'anysearch',  autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'ANYSEARCH_API_KEY',  maxSlots: 3 }, showInCredentialUi: true },
  { id: 'xai',        autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'XAI_API_KEY',        maxSlots: 3 }, showInCredentialUi: true },
  { id: 'brightdata', autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'BRIGHTDATA_API_KEY', maxSlots: 3 }, showInCredentialUi: true },
  { id: 'serpbase',   autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'SERPBASE_API_KEY',   maxSlots: 3 }, showInCredentialUi: true },
  { id: 'serper',     autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'SERPER_API_KEY',     maxSlots: 3 }, showInCredentialUi: true },
  { id: 'valyu',      autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'VALYU_API_KEY',      maxSlots: 3 }, showInCredentialUi: true },
  { id: 'kimi',       autoEligible: false, credential: { mode: 'api-key', canonicalRef: 'KIMI_API_KEY',       maxSlots: 3 }, showInCredentialUi: true },
  {
    id: 'parallelMcp',
    autoEligible: false,
    credential: { mode: 'api-key', canonicalRef: 'PARALLEL_MCP_API_KEY', maxSlots: 3 },
    showInCredentialUi: true,
  },
]

// Sanity: every provider id in ALL_PROVIDER_IDS must have metadata, and
// every metadata id must live in ALL_PROVIDER_IDS.
for (const m of PROVIDER_METADATA) {
  if (!ALL_PROVIDER_IDS.includes(m.id)) {
    throw new Error(`provider-metadata: id '${m.id}' is not in ALL_PROVIDER_IDS; keep config-schema and metadata in lockstep`)
  }
  if (m.autoEligible && !AUTO_CHAIN_PROVIDERS.includes(m.id)) {
    throw new Error(`provider-metadata: id '${m.id}' marked autoEligible but not in AUTO_CHAIN_PROVIDERS`)
  }
  if (!m.autoEligible && !EXPLICIT_ONLY_PROVIDERS.includes(m.id)) {
    throw new Error(`provider-metadata: id '${m.id}' marked !autoEligible but not in EXPLICIT_ONLY_PROVIDERS`)
  }
}

const METADATA_BY_ID = new Map(PROVIDER_METADATA.map((m) => [m.id, m]))

/**
 * @param {string} id
 * @returns {ProviderMetadata | undefined}
 */
export function getProviderMetadata(id) {
  return METADATA_BY_ID.get(id)
}

/**
 * @returns {ProviderMetadata[]}
 */
export function providersForCredentialUi() {
  return PROVIDER_METADATA.filter((m) => m.showInCredentialUi)
}

/**
 * Resolve an alias slot back to its canonical ref. Returns the input
 * unchanged when the input is already canonical. Used by credential
 * loaders so the legacy spellings (`FIRECRAWL_KEY`, `PARALLELMCP_API_KEY`,
 * …) are tolerated at read time and never surface to UI / pool paths.
 *
 * @param {string} ref
 * @returns {string}
 */
export function canonicalizeRef(ref) {
  if (typeof ref !== 'string') return ref
  for (const m of PROVIDER_METADATA) {
    if (m.credential.canonicalRef === ref) return ref
    if (m.credential.aliases && m.credential.aliases.includes(ref)) return m.credential.canonicalRef
  }
  return ref
}

/**
 * Compose the full fallback environment-name set that resolveCredential
 * should accept. Used by lib/credentials/resolve.js so the runtime
 * honours canonical AND alias spellings without ever writing them to UI.
 *
 * @param {string} providerId
 * @returns {string[]}
 */
export function fallbackEnvNames(providerId) {
  const m = METADATA_BY_ID.get(providerId)
  if (!m) return []
  const out = [m.credential.canonicalRef]
  if (m.credential.aliases) out.push(...m.credential.aliases)
  return out.filter((s) => typeof s === 'string' && s.length > 0)
}
