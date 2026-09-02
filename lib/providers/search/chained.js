// lib/providers/search/chained.js — v2.0 full searchChain (SPEC §II.3.3).
//
// Three routing modes (SPEC §II.2):
//   - 'auto':           sequential chain, credential-pool rotation per
//                       provider, fallback to next provider, mmx fallback last
//   - 'aggregate':      bounded parallel fan-out (aggregateMaxFanout),
//                       URL dedup, per-provider answer prefix
//   - '<id>' | [<ids>]: explicit single / ordered list, no cross-provider
//                       fallback on single
//
// Pool → Chain two-level fallback per §II.3.3:
//
//   2xx + sources         → healthy, return
//   429 / quota / limit   → quotaCooldown, next credential (pool rotation)
//   401 / confirmed auth  → invalid, next credential
//   missing credentialRef → next credentialRef
//   5xx / network         → retry THIS credential ONCE, then next provider
//   invalid-response      → next provider (no key drain)
//   abort                 → abort entire chain
//   security / SSRF       → throw immediately

import { mmxSearch, isMmxAvailable } from '../mmx.js'
import { redactCredential } from '../../key-redact.js'
import { runPool, buildPool, transitionState, poolSummary } from '../../credentials/pool.js'
import { classifyError, isFallbackable, withClass } from '../../classify-error.js'
import { resolveCredentialPool, providerCredentialRef, resolveEnvCredential } from '../../credentials/resolve.js'
import { makeLastError } from '../../credentials/last-error.js'
import {
  AUTO_CHAIN_PROVIDERS,
  EXPLICIT_ONLY_PROVIDERS,
  ALL_PROVIDER_IDS,
  CREDENTIAL_SLOTS_PER_PROVIDER,
} from '../../config-schema.js'

// ─────────────────────────────────────────────────────────────────────
// Provider registry — carried over from v1.0; modules unchanged.
// ─────────────────────────────────────────────────────────────────────

import * as searxng from './searxng.js'
import * as openai from './openai.js'
import * as exa from './exa.js'
import * as brave from './brave.js'
import * as parallel from './parallel.js'
import * as tinyfish from './tinyfish.js'
import * as search1api from './search1api.js'
import * as searchinfinity from './searchinfinity.js'
import * as querit from './querit.js'
import * as tavily from './tavily.js'
import * as firecrawl from './firecrawl.js'
import * as jina from './jina.js'
import * as serpdive from './serpdive.js'
import * as kagi from './kagi.js'
import * as bocha from './bocha.js'
import * as ollama from './ollama.js'
import * as perplexity from './perplexity.js'
import * as gemini from './gemini.js'
import * as duckduckgo from './duckduckgo.js'
import * as anysearch from './anysearch.js'
import * as xai from './xai.js'
import * as brightdata from './brightdata.js'
import * as serpbase from './serpbase.js'
import * as serper from './serper.js'
import * as valyu from './valyu.js'
import * as kimi from './kimi.js'
import * as parallelMcp from './parallel-mcp.js'

export const PROVIDER_REGISTRY = {
  searxng, openai, exa, brave, parallel, tinyfish, search1api, searchinfinity,
  querit, tavily, firecrawl, jina, serpdive, kagi, bocha, ollama, perplexity, gemini,
  duckduckgo, anysearch, xai, brightdata, serpbase, serper, valyu,
  kimi, parallelMcp,
}

export const ALL_ELIGIBLE_PROVIDERS = AUTO_CHAIN_PROVIDERS
export { EXPLICIT_ONLY_PROVIDERS }

/** Map of provider id → { fieldName, envName, envOverride? } for credential resolution. */
export const PROVIDER_CREDENTIAL_MAP = {
  searxng: { fieldName: 'searxngHost', envName: 'SEARXNG_HOST' },
  openai: { fieldName: 'openaiApiKey', envName: 'OPENAI_API_KEY' },
  exa: { fieldName: 'exaApiKey', envName: 'EXA_API_KEY' },
  brave: { fieldName: 'braveApiKey', envName: 'BRAVE_API_KEY' },
  parallel: { fieldName: 'parallelApiKey', envName: 'PARALLEL_API_KEY' },
  tinyfish: { fieldName: 'tinyfishApiKey', envName: 'TINYFISH_API_KEY' },
  search1api: { fieldName: 'search1apiApiKey', envName: 'SEARCH1API_API_KEY' },
  searchinfinity: { fieldName: 'searchinfinityApiKey', envName: 'SEARCHINFINITY_API_KEY' },
  querit: { fieldName: 'queritApiKey', envName: 'QUERIT_API_KEY' },
  tavily: { fieldName: 'tavilyApiKey', envName: 'TAVILY_API_KEY' },
  firecrawl: { fieldName: 'firecrawlKey', envName: 'FIRECRAWL_KEY' },
  jina: { fieldName: 'jinaApiKey', envName: 'JINA_API_KEY' },
  serpdive: { fieldName: 'serpdiveApiKey', envName: 'SERPDIVE_API_KEY' },
  kagi: { fieldName: 'kagiApiKey', envName: 'KAGI_API_KEY' },
  bocha: { fieldName: 'bochaApiKey', envName: 'BOCHA_API_KEY' },
  ollama: { fieldName: 'ollamaApiKey', envName: 'OLLAMA_API_KEY' },
  perplexity: { fieldName: 'perplexityApiKey', envName: 'PERPLEXITY_API_KEY' },
  gemini: { fieldName: 'geminiApiKey', envName: 'GEMINI_API_KEY' },
  duckduckgo: { fieldName: '', envName: '' },
  anysearch: { fieldName: 'anysearchApiKey', envName: 'ANYSEARCH_API_KEY' },
  xai: { fieldName: 'xaiApiKey', envName: 'XAI_API_KEY' },
  brightdata: { fieldName: 'brightdataApiKey', envName: 'BRIGHTDATA_API_KEY' },
  serpbase: { fieldName: 'serpbaseApiKey', envName: 'SERPBASE_API_KEY' },
  serper: { fieldName: 'serperApiKey', envName: 'SERPER_API_KEY' },
  valyu: { fieldName: 'valyuApiKey', envName: 'VALYU_API_KEY' },
  kimi: { fieldName: 'kimiApiKey', envName: 'KIMI_API_KEY' },
  parallelMcp: { fieldName: 'parallelMcpApiKey', envName: 'PARALLEL_MCP_API_KEY' },
}

export const PROVIDER_SPECIFIC_CONFIG = {
  firecrawl: ['firecrawlBaseUrl'],
  brightdata: ['brightdataUnlockerZone'],
  gemini: ['geminiModel', 'geminiAuth'],
  kimi: ['kimiEndpoint'],
  parallelMcp: ['parallelMcp'],
}

// ─────────────────────────────────────────────────────────────────────
// Runtime state — process-local in-memory pool state for doctor reports.
// ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, import('../../credentials/pool.js').CredentialEntry[]>} */
const poolState = new Map()
/** @type {Map<string, import('../../credentials/last-error.js').LastError>} */
const lastErrorState = new Map()

export function getPoolState(providerId) {
  return poolState.get(providerId) || []
}

export function setPoolState(providerId, pool) {
  if (Array.isArray(pool)) poolState.set(providerId, pool)
}

export function getLastError(providerId) {
  return lastErrorState.get(providerId) || null
}

function recordLastError(providerId, errorClass, opts) {
  lastErrorState.set(providerId, makeLastError(providerId, errorClass, opts))
}

export function clearProviderRuntimeState() {
  poolState.clear()
  lastErrorState.clear()
}

// ─────────────────────────────────────────────────────────────────────
// Public entry points.
// ─────────────────────────────────────────────────────────────────────

/**
 * Cheap local availability check (no network calls).
 *
 * @param {{ resolved?: Record<string, any>, rawConfig?: any }} loaded
 * @returns {boolean}
 */
export function isChainedSearchAvailable(loaded) {
  if (loaded && loaded.resolved) {
    for (const id of ALL_ELIGIBLE_PROVIDERS) {
      const c = loaded.resolved[id]
      if (c && typeof c.key === 'string' && c.key.length > 0) return true
    }
  }
  return isMmxAvailable()
}

/**
 * Convert the routing parameter from web_search_ex into a normalized
 * SearchRouting union.
 *
 *   'auto'      → 'auto'      (sequential chain with credential pool rotation)
 *   'aggregate' → 'aggregate' (bounded parallel fan-out)
 *   '<id>'      → { kind: 'single', id }
 *   ['<id>']    → { kind: 'single', id }   (single-element ordered list)
 *   ['<id>',…]  → { kind: 'ordered', ids }
 *
 * @param {unknown} routing
 * @returns {'auto' | 'aggregate' | { kind: 'single', id: string } | { kind: 'ordered', ids: string[] }}
 */
export function selectRouting(routing) {
  if (routing === undefined || routing === null || routing === 'auto') return 'auto'
  if (routing === 'aggregate') return 'aggregate'
  if (typeof routing === 'string') return { kind: 'single', id: routing }
  if (Array.isArray(routing)) {
    const ids = routing.filter((s) => typeof s === 'string' && s.length > 0)
    if (ids.length === 0) return 'auto'
    if (ids.length === 1) return { kind: 'single', id: ids[0] }
    return { kind: 'ordered', ids }
  }
  return 'auto'
}

/**
 * v1.0 compatibility shim. Reads `searchProviderOrder` from a config
 * object and returns the v1-style mode ('auto' | 'all' | string[]).
 *
 * @param {any} cfg
 * @returns {'auto' | 'all' | string[]}
 */
export function selectModeFromConfig(cfg) {
  const v = cfg && cfg.searchProviderOrder
  if (v === undefined || v === null || v === 'auto') return 'auto'
  if (v === 'all') return 'all'
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.length > 0)
  return 'auto'
}

/**
 * Main entry point. Implements SPEC §II.3.3 + §II.2 searchChain semantics.
 *
 * @param {{ query: string, maxResults?: number, routing?: unknown }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ resolved?: Record<string, any>, rawConfig?: any, config?: any,
 *            keysForRedaction: string[], ctx?: any }} ctx
 * @returns {Promise<any>}
 */
export async function chainedSearch(request, signal, ctx) {
  const query = (request && typeof request.query === 'string') ? request.query.trim() : ''
  if (!query) {
    const e = new Error('query must be a non-empty string')
    e.code = 'WEB_PROVIDER_BAD_REQUEST'
    throw e
  }
  const maxResults = clampMaxResults(request && request.maxResults)
  // v2.0 native: prefer request.routing; fall back to ctx.config.searchProviderOrder
  // for v1 compat (test fixtures and any code still calling chainedSearch directly).
  const configRouting = ctx && ctx.config && ctx.config.searchProviderOrder
  const routing = selectRouting(
    (request && request.routing !== undefined) ? request.routing : configRouting
  )
  const cfg = (ctx && ctx.config) || {}
  const keys = ctx.keysForRedaction || []
  const budgets = {
    totalMs: cfg.searchTotalTimeoutMs || 30000,
    perProviderMs: cfg.perProviderTimeoutMs || 8000,
    perKeyMs: cfg.perKeyTimeoutMs || 8000,
    maxProviders: cfg.maxProvidersPerSearch || 18,
    maxKeys: cfg.maxKeysPerProvider || 3,
    aggregateMaxFanout: cfg.aggregateMaxFanout || 4,
  }
  const startedAt = Date.now()
  const deadline = startedAt + budgets.totalMs

  if (routing === 'aggregate') {
    return runAggregate(query, maxResults, signal, ctx, keys, budgets, deadline)
  }
  if (typeof routing === 'object' && routing.kind === 'single') {
    return runSingleChain(query, maxResults, signal, ctx, keys, budgets, deadline, [routing.id], /* singleProvider */ true)
  }
  if (typeof routing === 'object' && routing.kind === 'ordered') {
    return runSingleChain(query, maxResults, signal, ctx, keys, budgets, deadline, routing.ids, /* singleProvider */ false)
  }
  // 'auto'
  return runAuto(query, maxResults, signal, ctx, keys, budgets, deadline)
}

// ─────────────────────────────────────────────────────────────────────
// Routing implementations.
// ─────────────────────────────────────────────────────────────────────

async function runAuto(query, maxResults, signal, ctx, keys, budgets, deadline) {
  // Build the provider list. SearXNG is prepended when the user has a
  // configured host; otherwise it's skipped (it has credentialMode 'none'
  // with public-host semantics).
  const providerList = buildAutoChainList(ctx)

  const attempts = []
  let visited = 0
  for (const providerId of providerList) {
    if (visited >= budgets.maxProviders) break
    if (signal && signal.aborted) {
      throw makeAbortError()
    }
    if (Date.now() >= deadline) {
      attempts.push({ provider: providerId, class: 'budget' })
      break
    }
    visited++
    const r = await tryProvider(providerId, query, maxResults, signal, ctx, keys, budgets, deadline)
    if (r.ok) {
      return shapeResult(r.value, maxResults, providerId)
    }
    attempts.push(...r.attempts.map((a) => ({ provider: providerId, ...a })))
    // If a hard error was thrown (security / config / invalid-request),
    // runProvider would already have thrown. So getting here means every
    // outcome was fallbackable OR the provider returned 'invalid-response'.
  }
  // mmx fallback (SPEC §II.3.3)
  if ((ctx.config && ctx.config.mmxFallback !== false) && isMmxAvailable() && Date.now() < deadline) {
    try {
      const r = await mmxSearch(query, maxResults, signal)
      return shapeResult(r, maxResults, 'mmx')
    } catch (e) {
      const cls = classifyError(e)
      attempts.push({ provider: 'mmx', class: cls, credentialMode: 'none' })
    }
  }

  throw buildExhaustedError(attempts, providerList.length)
}

async function runSingleChain(query, maxResults, signal, ctx, keys, budgets, deadline, ids, singleProvider) {
  if (!ids || ids.length === 0) {
    throw buildExhaustedError([], 0)
  }
  const attempts = []
  for (const providerId of ids) {
    if (signal && signal.aborted) {
      throw makeAbortError()
    }
    if (Date.now() >= deadline) {
      attempts.push({ provider: providerId, class: 'budget' })
      break
    }
    const r = await tryProvider(providerId, query, maxResults, signal, ctx, keys, budgets, deadline)
    if (r.ok) {
      return shapeResult(r.value, maxResults, providerId)
    }
    attempts.push(...r.attempts.map((a) => ({ provider: providerId, ...a })))
    // Single-provider routing: stop after the first provider whether it
    // succeeded or not (SPEC §II.3.3 "Single call, no fallback to another
    // provider"). The caller can interpret r.ok + attempts.
    if (singleProvider) break
  }
  if (singleProvider) {
    // No cross-provider fallback on single mode — surface the last
    // attempt's error directly.
    const last = attempts[attempts.length - 1] || {}
    const e = new Error(`provider ${last.provider || ids[0]} failed: ${last.class || 'unknown'}`)
    e.code = 'WEB_PROVIDER_ERROR'
    e.attempts = attempts
    e.singleProvider = true
    throw e
  }
  throw buildExhaustedError(attempts, ids.length)
}

async function runAggregate(query, maxResults, signal, ctx, keys, budgets, deadline) {
  // Bounded parallel fan-out across all eligible providers. URL dedup.
  const providerList = buildAutoChainList(ctx)
  const fanout = Math.max(1, Math.min(8, budgets.aggregateMaxFanout))
  const seen = new Set()
  /** @type {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>} */
  const sources = []
  /** @type {Array<{ provider: string, answer?: string, results?: any[] }>} */
  const providerResponses = []
  /** @type {Array<{ provider: string, error: string }>} */
  const providerErrors = []
  /** @type {Map<string, any[]>} */
  const pools = new Map()

  const queue = providerList.slice()
  let visited = 0
  const workers = []
  for (let i = 0; i < fanout; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        if (signal && signal.aborted) throw makeAbortError()
        if (Date.now() >= deadline) return
        if (visited >= budgets.maxProviders) return
        const providerId = queue.shift()
        if (!providerId) return
        visited++
        const r = await tryProvider(providerId, query, maxResults, signal, ctx, keys, budgets, deadline)
        if (r.ok) {
          pools.set(providerId, r.pool)
          const shaped = shapeResult(r.value, maxResults, providerId)
          for (const src of shaped.sources) {
            if (!seen.has(src.url)) {
              seen.add(src.url)
              sources.push(src)
            }
          }
          if (shaped.content) {
            providerResponses.push({ provider: providerId, answer: shaped.content, results: shaped.sources })
          } else {
            providerResponses.push({ provider: providerId, results: shaped.sources })
          }
        } else {
          pools.set(providerId, r.pool)
          for (const a of r.attempts) {
            providerErrors.push({ provider: providerId, error: `${a.credentialRef || '-'}:${a.class}` })
          }
        }
      }
    })())
  }
  await Promise.allSettled(workers)
  for (const [id, p] of pools) setPoolState(id, p)
  if (sources.length === 0) {
    throw buildExhaustedError(providerErrors.flatMap((e) => ({ provider: e.provider, class: 'unknown' })), providerList.length)
  }
  const result = {
    sources: sources.slice(0, maxResults),
    truncated: sources.length > maxResults,
    provider: 'aggregate',
  }
  const answer = providerResponses.map((r) => r.answer).filter((a) => typeof a === 'string' && a.length > 0).join('\n\n')
  if (answer.length > 0) result.content = answer
  if (providerResponses.length > 0) result.providerResponses = providerResponses
  if (providerErrors.length > 0) result.providerErrors = providerErrors
  return result
}

// ─────────────────────────────────────────────────────────────────────
// Provider runner.
// ─────────────────────────────────────────────────────────────────────

/**
 * Try one provider end-to-end (build pool, run pool runner).
 *
 * @returns {Promise<{ ok: true, value: any, pool: any[] } | { ok: false, attempts: any[], pool: any[] }>}
 */
async function tryProvider(providerId, query, maxResults, signal, ctx, keys, budgets, deadline) {
  const mod = PROVIDER_REGISTRY[providerId]
  if (!mod) {
    return {
      ok: false,
      attempts: [{ credentialRef: null, class: 'config' }],
      pool: [],
    }
  }
  // SearXNG is special: it expects a HOST URL not an API key.
  const credentialMode = providerId === 'searxng' ? 'host' : (providerId === 'mmx' ? 'none' : 'pool')

  // Resolve the credential pool. Pool entries are CredentialEntry-shaped
  // (state machine); the runner uses credentialMode 'pool' by default.
  let pool
  let poolResolved = {}
  if (credentialMode === 'pool') {
    const resolved = await resolveProviderCredentials(providerId, ctx, budgets.maxKeys)
    poolResolved = resolved
    pool = buildPool(providerId, { resolved }, budgets.maxKeys)
    // Drop entries with no resolved value — but the runner still tries
    // them as 'credential' (missing-ref) per the decision table.
  } else if (credentialMode === 'host') {
    const host = await resolveSearxngHost(ctx)
    if (!host) {
      // No host → mark provider as having a credential gap and move on.
      return {
        ok: false,
        attempts: [{ credentialRef: null, class: 'credential' }],
        pool: [],
      }
    }
    pool = [{
      credentialRef: 'SEARXNG_HOST',
      state: 'unknown',
    }]
  } else {
    // mmx / none-mode providers
    pool = [{ credentialRef: null, state: 'unknown' }]
  }

  // Run the pool runner. The fetch closure invokes the actual provider.
  // R3 P0 #7: the inner fetch closure threads the pool-resolved map
  // through `ctx.poolResolved` so resolveProviderKey can read the
  // picked slot's key (NOT just the legacy single-slot).
  const fetchCtx = { ...ctx, poolResolved }
  let poolResult
  try {
    poolResult = await runPool({
      providerId,
      pool,
      maxKeys: budgets.maxKeys,
      perKeyTimeoutMs: budgets.perKeyMs,
      keysForRedaction: keys,
      signal,
      fetch: async (credentialRef, sig, picked) => {
        const apiKey = credentialMode === 'host' ? await resolveSearxngHost(ctx) : await resolveProviderKey(providerId, picked, fetchCtx)
        const providerSpecific = {}
        const extras = PROVIDER_SPECIFIC_CONFIG[providerId] || []
        for (const key of extras) {
          const v = ctx.rawConfig && ctx.rawConfig[key]
          if (typeof v === 'string' && v.length > 0) providerSpecific[key] = v
        }
        const opts = Object.keys(providerSpecific).length > 0 ? { providerSpecific } : {}
        return mod.providerSearch(query, maxResults, apiKey, sig, opts)
      },
    })
  } catch (e) {
    // Hard throw (security / config / invalid-request / aborted).
    recordLastError(providerId, classifyError(e), {
      credentialRef: pool[0] && pool[0].credentialRef,
      credentialMode,
    })
    throw e
  }

  setPoolState(providerId, poolResult.pool)
  // Track last error per provider for the doctor.
  if (!poolResult.ok && poolResult.attempts.length > 0) {
    const last = poolResult.attempts[poolResult.attempts.length - 1]
    recordLastError(providerId, last ? last.class : 'unknown', {
      credentialRef: last ? last.credentialRef : null,
      credentialMode,
    })
  }
  return poolResult
}

/**
 * Resolve every key slot for one provider. Returns a map from the
 * canonical env-name ref (`EXA_API_KEY`, `EXA_API_KEY_2`, …) →
 * { key, source, raw } | null.
 */
async function resolveProviderCredentials(providerId, ctx, maxKeys) {
  if (ctx && ctx.resolved && ctx.resolved[providerId]) {
    // The caller's pre-resolved single-slot map (v1 carry-over). Synthesize
    // a per-slot map for the pool runner.
    const r = ctx.resolved[providerId]
    return { [providerCredentialRef(providerId, 1)]: r }
  }
  if (ctx && ctx.ctx && typeof ctx.ctx.get === 'function') {
    return resolveCredentialPool(providerId, ctx.ctx, maxKeys)
  }
  return {}
}

/**
 * Resolve the actual API key for a given (providerId, credentialRef) pair.
 *
 * R3 P0 #7: the runner passes a `credentialRef` per slot (e.g.
 * `KIMI_API_KEY_2`). We must honour that ref rather than always
 * returning slot 1 — otherwise the credential pool's per-slot rotation
 * is a no-op and the chain never engages key rotation / cooldown on
 * the per-slot basis SPEC §II.3.3 promises.
 *
 * Lookup order:
 *   1. The pool-resolved map (ctx.poolResolved[credentialRef]) — set
 *      by resolveProviderCredentials above.
 *   2. ctx.resolved[providerId] — v1 single-slot legacy compatibility.
 *   3. rawConfig.<fieldName> / env.<ENV_NAME> — last-resort fallback
 *      for tests + non-pool paths.
 *
 * @param {string} providerId
 * @param {string | null} credentialRef
 * @param {any} ctx
 */
async function resolveProviderKey(providerId, credentialRef, ctx) {
  if (ctx && ctx.poolResolved && credentialRef && ctx.poolResolved[credentialRef]) {
    const r = ctx.poolResolved[credentialRef]
    if (r && typeof r.key === 'string' && r.key.length > 0) return r.key
  }
  // v1 single-slot legacy compatibility.
  if (ctx && ctx.resolved && ctx.resolved[providerId]) {
    return ctx.resolved[providerId].key
  }
  // Last-resort fallback for tests / non-pool paths.
  const map = PROVIDER_CREDENTIAL_MAP[providerId]
  if (!map || !map.fieldName) return null
  if (providerId === 'duckduckgo') return null
  const cfgValue = ctx.rawConfig ? ctx.rawConfig[map.fieldName] : undefined
  if (typeof cfgValue === 'string' && cfgValue.length > 0) return cfgValue
  const env = map.envName ? process.env[map.envName] : null
  return env || null
}

/**
 * Resolve the self-hosted SearXNG instance URL. Lookup order:
 *   1. settings (rawConfig.searxngHost — schema field, v2.2)
 *   2. DSH credentials seam / process env ($SEARXNG_HOST)
 *
 * @param {any} ctx
 * @returns {Promise<string | null>}
 */
async function resolveSearxngHost(ctx) {
  if (ctx && ctx.rawConfig && typeof ctx.rawConfig.searxngHost === 'string' && ctx.rawConfig.searxngHost.length > 0) {
    return ctx.rawConfig.searxngHost
  }
  if (ctx && ctx.ctx && typeof ctx.ctx.get === 'function') {
    const v = await resolveEnvCredential(ctx.ctx, 'SEARXNG_HOST')
    if (v) return v
  }
  const env = process.env.SEARXNG_HOST
  return (typeof env === 'string' && env.length > 0) ? env : null
}

function buildAutoChainList(ctx) {
  const list = []
  const host = (ctx && ctx.rawConfig && typeof ctx.rawConfig.searxngHost === 'string' && ctx.rawConfig.searxngHost.length > 0)
    ? ctx.rawConfig.searxngHost
    : (typeof process.env.SEARXNG_HOST === 'string' && process.env.SEARXNG_HOST.length > 0 ? process.env.SEARXNG_HOST : null)
  if (host) {
    list.push('searxng')
  }
  for (const id of AUTO_CHAIN_PROVIDERS) {
    if (id === 'searxng') continue // already prepended
    list.push(id)
  }
  return list
}

// ─────────────────────────────────────────────────────────────────────
// Result shaping.
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {any} raw
 * @param {number} maxResults
 * @param {string} providerId
 */
export function shapeResult(raw, maxResults, providerId) {
  const allSources = Array.isArray(raw && raw.sources) ? raw.sources : []
  const sliced = allSources.slice(0, maxResults)
  const sources = sliced
    .filter((s) => s && typeof s.url === 'string' && s.url.length > 0)
    .map((s) => {
      const out = { url: s.url }
      if (s.title) out.title = String(s.title)
      if (s.snippet) out.snippet = String(s.snippet)
      if (s.publishedAt) {
        const iso = toIso8601(s.publishedAt)
        if (iso) out.publishedAt = iso
      }
      return out
    })
  const out = { sources, truncated: allSources.length > maxResults, provider: providerId }
  if (raw && typeof raw.content === 'string' && raw.content.length > 0) out.content = raw.content
  return out
}

function toIso8601(s) {
  // Reuse v1.0 helper if available, otherwise fall back.
  if (typeof s !== 'string') return undefined
  const t = Date.parse(s)
  if (isNaN(t)) {
    // try replacing a space separator with 'T'
    const t2 = Date.parse(s.replace(' ', 'T'))
    if (isNaN(t2)) return undefined
    return new Date(t2).toISOString()
  }
  return new Date(t).toISOString()
}

// ─────────────────────────────────────────────────────────────────────
// Error helpers.
// ─────────────────────────────────────────────────────────────────────

function makeAbortError() {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

function clampMaxResults(v) {
  return Math.max(1, Math.min(20, Number(v) || 8))
}

/**
 * Build the structured WEB_SEARCH_CHAIN_EXHAUSTED error per SPEC §II.3.3.
 *
 * @param {Array<{ provider: string, class: string, credentialRef?: string|null, credentialMode?: string, cooldownUntil?: number }>} attempts
 * @param {number} providerListSize
 */
function buildExhaustedError(attempts, providerListSize) {
  const err = new Error('search chain exhausted; see attempts[]')
  err.code = 'WEB_SEARCH_CHAIN_EXHAUSTED'
  err.name = 'WebError'
  err.attempts = attempts.map((a) => ({
    provider: a.provider,
    class: a.class,
    ...(a.credentialRef ? { credentialRef: a.credentialRef } : {}),
    ...(a.credentialMode ? { credentialMode: a.credentialMode } : {}),
    ...(a.cooldownUntil ? { cooldownUntil: a.cooldownUntil } : {}),
  }))
  err.registeredCount = ALL_PROVIDER_IDS.length
  err.eligibleCount = ALL_ELIGIBLE_PROVIDERS.length + 1 // +1 for searxng if configured
  err.attemptedCount = attempts.length
  err.skippedCount = Math.max(0, err.eligibleCount - attempts.length)
  err.doctorRecommended = true
  return err
}

// Re-exports so doctor / commands can introspect.
export { classifyError, poolSummary }
export { transitionState }
