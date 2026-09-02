// lib/doctor/probe.js — CapabilityProbe (SPEC §II.1 / §II.5 web_doctor).
//
// Passive by default: read-only, no network calls, no credential state
// changes. activeProbe: true explicitly opts in to real probes.

import { getPoolState, getLastError, PROVIDER_REGISTRY } from '../providers/search/chained.js'
import { isLastError } from '../credentials/last-error.js'
import { AUTO_CHAIN_PROVIDERS, EXPLICIT_ONLY_PROVIDERS } from '../config-schema.js'
import { poolSummary } from '../credentials/pool.js'
import { resolveCredentialPool } from '../credentials/resolve.js'
import { stats } from '../cache/index.js'
import { list } from '../cache/index.js'

/**
 * Number of "unhealthy" providers (lastErrorClass is `quotaCooldown` or
 * `auth`) required to escalate severity to `degraded` / `unavailable`
 * (P3 #23).
 */
const DOCTOR_DEGRADED_THRESHOLD = 1
const DOCTOR_UNAVAILABLE_THRESHOLD = 3

// R3 P0 #4: real active probe — HEAD request with bounded timeout.
// Per SPEC §III.2 Commit 3 exit criteria, `activeProbe: true` must
// actually ping providers (not just set a flag).
const ACTIVE_PROBE_TIMEOUT_MS = 3000

// Known health endpoints per provider. Conservative — only the search
// providers that ship a documented /healthz or root endpoint. We treat
// any network error as 'unhealthy' (timeout, dns, refused, non-2xx).
const PROVIDER_HEALTH_URLS = {
  searxng: (cfg) => cfg && cfg.searxngHost ? `${String(cfg.searxngHost).replace(/\/$/, '')}/healthz` : null,
  openai: () => 'https://api.openai.com/v1/models',
  exa: () => 'https://api.exa.ai/health',
  brave: () => 'https://api.search.brave.com/health/ping',
  parallel: () => 'https://api.parallel.ai/v1/health',
  jina: () => 'https://s.jina.ai/',
  tavily: () => 'https://api.tavily.com/',
  firecrawl: (cfg) => cfg && cfg.firecrawlBaseUrl ? `${String(cfg.firecrawlBaseUrl).replace(/\/$/, '')}/health` : 'https://api.firecrawl.dev/health',
  kagi: () => 'https://kagi.com/',
  perplexity: () => 'https://api.perplexity.ai/',
  gemini: () => 'https://generativelanguage.googleapis.com/',
  duckduckgo: () => 'https://duckduckgo.com/',
  anysearch: () => 'https://api.any.ai/',
  valyu: () => 'https://api.valyu.ai/',
  serper: () => 'https://google.serper.dev/',
  kimi: () => 'https://api.moonshot.cn/',
  parallelMcp: () => 'https://api.parallel.ai/',
}

/**
 * @param {any} ctx
 * @param {any} settings
 */
export function createProbe(ctx, settings) {
  return {
    /**
     * @param {{ activeProbe?: boolean }} [opts]
     */
    async run(opts = {}) {
      const active = opts.activeProbe === true
      const out = {
        severity: 'ok',
        providers: [],
        adapters: [],
        cache: stats(ctx),
        proxy: { configured: false, fromEnv: !!process.env.HTTPS_PROXY || !!process.env.HTTP_PROXY },
        identity: readIdentityFields(ctx),
        model: readModelInfo(ctx),
      }

      // Providers (read-only). For passive mode, only inspect last-known
      // state from poolState + lastErrorState.
      const seen = new Set()
      const providerRows = []
      for (const id of [...AUTO_CHAIN_PROVIDERS, ...EXPLICIT_ONLY_PROVIDERS]) {
        if (seen.has(id)) continue
        seen.add(id)
        const pool = getPoolState(id) || []
        let summary = poolSummary(pool)
        if (summary.configured === 0) {
          // Fresh boot / no search ran yet: the in-memory pool is empty.
          // Resolve the live credential state through the seam (local
          // read-only work — no network, no state change) so the doctor
          // reports what the chain WILL see, not "0 configured".
          try {
            const resolved = await resolveCredentialPool(id, ctx, 3)
            const liveCount = Object.values(resolved).filter((r) => !!r).length
            summary = liveCount > 0
              ? { configured: liveCount, healthy: 0, cooldown: 0, invalid: 0, unknown: 0 }
              : summary
          } catch {
            // keep the in-memory summary
          }
        }
        const lastErr = getLastError(id)
        const credentialMode = id === 'searxng' ? 'none' : 'pool'
        providerRows.push({
          id,
          credentialMode,
          credentials: summary.configured > 0
            ? `${summary.configured} configured / ${summary.healthy} healthy / ${summary.cooldown} cooldown / ${summary.invalid} invalid`
            : '0 configured',
          lastErrorClass: lastErr ? lastErr.class : undefined,
        })
      }
      // mmx is a credentialMode='none' provider in the fallback chain.
      providerRows.push({ id: 'mmx', credentialMode: 'none' })

      // R3 P0 #4: when activeProbe: true, actually ping each provider's
      // health endpoint with a bounded timeout. Records `lastPing` per
      // provider with status (healthy / unhealthy / timeout / dns-error)
      // and latencyMs. The flag is also set so downstream consumers can
      // distinguish real probe data from passive mode.
      if (active) {
        out.activeProbe = true
        const cfg = settings || {}
        const pingPromises = providerRows.map(async (row) => {
          const urlFn = PROVIDER_HEALTH_URLS[row.id]
          const url = urlFn ? urlFn(cfg) : null
          if (!url) {
            row.lastPing = { status: 'unknown', reason: 'no-health-endpoint' }
            return
          }
          row.lastPing = await pingHealth(url, ACTIVE_PROBE_TIMEOUT_MS)
        })
        await Promise.allSettled(pingPromises)
      }
      out.providers = providerRows

      // Adapters (P2 #16: only GenericHTML is shipped in R1; the others
      // are pending Commit 3 and reported as such so users don't ask the
      // doctor about non-existent capabilities.)
      const adapterEnabled = (id) => !!(settings && settings.adapters && settings.adapters[id] && settings.adapters[id].enabled !== false)
      out.adapters = [
        { id: 'github', activeBackend: 'gh', tier: 0, cheap: true, enabled: adapterEnabled('github'), status: 'active' },
        { id: 'youtube', activeBackend: 'yt-dlp', tier: 0, cheap: true, enabled: adapterEnabled('youtube'), status: 'active' },
        { id: 'rss', activeBackend: 'native', tier: 0, cheap: true, enabled: adapterEnabled('rss'), status: 'active' },
        { id: 'pdf', activeBackend: 'unpdf', tier: 0, cheap: true, enabled: adapterEnabled('pdf'), status: 'active' },
        { id: 'genericHtml', activeBackend: 'rsc-then-readability', tier: 0, cheap: true, enabled: adapterEnabled('genericHtml'), status: 'active' },
      ]

      // Severity
      let severity = 'ok'
      const unhealthyCount = out.providers.filter((p) => {
        const last = getLastError(p.id)
        return isLastError(last) && (last.class === 'quotaCooldown' || last.class === 'auth')
      }).length
      if (unhealthyCount >= DOCTOR_UNAVAILABLE_THRESHOLD) severity = 'unavailable'
      else if (unhealthyCount >= DOCTOR_DEGRADED_THRESHOLD) severity = 'degraded'
      out.severity = severity

      return out
    },

    list(ctx) {
      return list(ctx)
    },
  }
}

/**
 * @param {any} ctx
 */
function readIdentityFields(ctx) {
  const fields = {}
  if (ctx && typeof ctx.get === 'function') {
    try {
      const agents = ctx.get('agents')
      if (agents && typeof agents.currentInitiator === 'function') {
        const a = agents.currentInitiator()
        if (a && typeof a.sessionId === 'string') fields.sessionIdField = 'agents.currentInitiator().sessionId'
        else if (a && typeof a.id === 'string') fields.sessionIdField = 'agents.currentInitiator().id'
      }
    } catch {
      // ignore — agents may not be available in every context
    }
  }
  return fields
}

/**
 * @param {any} ctx
 */
function readModelInfo(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return { provider: 'unknown', capabilities: { hostedSearch: false } }
  const m = ctx.get('agentDefaultModel')
  if (!m || typeof m.currentSelection !== 'function') return { provider: 'unknown', capabilities: { hostedSearch: false } }
  try {
    const s = m.currentSelection()
    return { provider: (s && typeof s.provider === 'string') ? s.provider : 'unknown', capabilities: { hostedSearch: false } }
  } catch {
    return { provider: 'unknown', capabilities: { hostedSearch: false } }
  }
}

/**
 * R3 P0 #4: bounded health ping. Returns `{status, latencyMs}` for
 * downstream consumption. Never throws; always resolves.
 *
 * @param {string} url
 * @param {number} timeoutMs
 */
async function pingHealth(url, timeoutMs) {
  const startedAt = Date.now()
  let timer
  try {
    const ac = new AbortController()
    timer = setTimeout(() => ac.abort(), timeoutMs)
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ac.signal,
    })
    const latencyMs = Date.now() - startedAt
    clearTimeout(timer)
    if (response.status >= 200 && response.status < 400) {
      return { status: 'healthy', latencyMs }
    }
    return { status: 'unhealthy', latencyMs, httpStatus: response.status }
  } catch (e) {
    if (timer) clearTimeout(timer)
    const latencyMs = Date.now() - startedAt
    const msg = (e && e.message ? e.message : String(e)).toLowerCase()
    if (msg.includes('abort')) return { status: 'timeout', latencyMs }
    if (msg.includes('enotfound') || msg.includes('dns')) return { status: 'dns-error', latencyMs }
    if (msg.includes('econnrefused') || msg.includes('econnreset')) return { status: 'connection-error', latencyMs }
    return { status: 'unhealthy', latencyMs, reason: msg.slice(0, 100) }
  }
}
