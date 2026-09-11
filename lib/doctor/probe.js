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
// providers that ship a documented /healthz or root endpoint.
//
// A keyless HEAD probe can only establish REACHABILITY, never health.
// See pingHealth for how each response class is classified: in short,
// only a network failure or a 5xx means something is wrong, and
// 401/403/405 mean the opposite — the service answered.
const PROVIDER_HEALTH_URLS = {
  searxng: (cfg) => cfg && cfg.searxngHost ? `${String(cfg.searxngHost).replace(/\/$/, '')}/healthz` : null,
  // v2.3.0: openai row removed (Hosted Search half-implementation
  // removed per spec § 六). If the auto chain ever re-adds openai the
  // URL must be re-applied here.
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
  // anysearch: until 2026-09-11 this pointed at https://api.any.ai/ — a
  // different host from the one the adapter actually calls
  // (https://api.anysearch.com/v1/search). Every path on the real host
  // answers 404 without a key while a keyed call returns 200, so no
  // keyless probe can ever call anysearch healthy. The corrected URL
  // therefore lands on `unknown (no-health-path)` — the honest verdict —
  // instead of spending a request on the wrong service.
  anysearch: () => 'https://api.anysearch.com/',
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
        // `observed`  — a real pool whose states were set by actual requests.
        // `unprobed`  — a credential exists but NOTHING has measured it, so
        //               its health is unknown, not zero.
        // `none`      — no credential is configured (or the row needs none).
        let credentialSource = summary.configured > 0 ? 'observed' : 'none'
        if (summary.configured === 0) {
          // Fresh boot / no search ran yet: the in-memory pool is empty.
          // Resolve the live credential state through the seam (local
          // read-only work — no network, no state change) so the doctor
          // reports what the chain WILL see, not "0 configured".
          try {
            const resolved = await resolveCredentialPool(id, ctx, 3)
            const liveCount = Object.values(resolved).filter((r) => !!r).length
            if (liveCount > 0) {
              // Nothing has exercised these credentials yet, so every one
              // of them is `unknown`. Do NOT report `healthy: 0` here:
              // that reads as "configured but broken" and has already
              // sent a user chasing a key that was in fact fine.
              summary = { configured: liveCount, healthy: 0, cooldown: 0, invalid: 0, unknown: liveCount }
              credentialSource = 'unprobed'
            }
          } catch {
            // keep the in-memory summary
          }
        }
        const lastErr = getLastError(id)
        const credentialMode = id === 'searxng' ? 'none' : 'pool'
        providerRows.push({
          id,
          credentialMode,
          credentialsSource: credentialSource,
          credentials: renderCredentials(summary, credentialSource),
          lastErrorClass: lastErr ? lastErr.class : undefined,
        })
      }
      // mmx is a credentialMode='none' provider in the fallback chain.
      providerRows.push({ id: 'mmx', credentialMode: 'none', credentialsSource: 'none', credentials: 'not required' })

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
 * Render one provider's credential line.
 *
 * An `unprobed` row must never render as `0 healthy`. Health is a
 * measurement, and until a request (or an `activeProbe` ping) has run
 * there is nothing to measure — a literal `0 healthy` reads as
 * "configured but broken" and has already sent a user chasing a key
 * that was in fact fine. Say `unknown` and name the way to resolve it.
 *
 * @param {{ configured: number, healthy: number, cooldown: number, invalid: number, unknown: number }} summary
 * @param {'observed' | 'unprobed' | 'none'} source
 * @returns {string}
 */
function renderCredentials(summary, source) {
  if (summary.configured === 0) return '0 configured'
  if (source === 'unprobed') {
    return `${summary.configured} configured / health unknown (nothing has measured it yet -- run a search, or pass activeProbe:true for endpoint reachability)`
  }
  return `${summary.configured} configured / ${summary.healthy} healthy / ${summary.cooldown} cooldown / ${summary.invalid} invalid`
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
 * The probe is a single unauthenticated HEAD, so it can establish
 * REACHABILITY but never "health" in the sense of "this provider works
 * with your key". The verdicts are therefore about what the response
 * proves, not about whether the provider is usable:
 *
 *   healthy         2xx/3xx — answered and accepted the probe.
 *   reachable       401/403/405 — answered and DECLINED: it wants
 *                   credentials, or does not allow HEAD. This is
 *                   positive evidence the service is up. Reporting it
 *                   as `unhealthy` is what made activeProbe useless:
 *                   measured 2026-09-11, these codes covered parallel,
 *                   parallelMcp, brave, valyu, serper and tavily — all
 *                   of which work with a key.
 *   unknown         404 — answered, but nothing lives at this path. For
 *                   a provider with no documented health endpoint that
 *                   says nothing about health (every path on
 *                   api.anysearch.com 404s without a key while the keyed
 *                   search call returns 200). Also used for other
 *                   unexpected 4xx.
 *   unhealthy       5xx — the service answered with a server error.
 *   timeout / dns-error / connection-error — no usable answer.
 *
 * Measured 2026-09-11 with this ping: only 3 of the 15 mapped endpoints
 * returned 2xx, so the old "non-2xx is unhealthy" rule reported a wall
 * of false failures for providers that were up and keyed.
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
    const s = response.status
    if (s >= 200 && s < 400) {
      return { status: 'healthy', latencyMs }
    }
    if (s === 401 || s === 403 || s === 405) {
      return { status: 'reachable', latencyMs, httpStatus: s, reason: 'auth-or-method-required' }
    }
    if (s === 404) {
      return { status: 'unknown', latencyMs, httpStatus: s, reason: 'no-health-path' }
    }
    if (s >= 500) {
      return { status: 'unhealthy', latencyMs, httpStatus: s }
    }
    return { status: 'unknown', latencyMs, httpStatus: s }
  } catch (e) {
    if (timer) clearTimeout(timer)
    const latencyMs = Date.now() - startedAt
    const msg = (e && e.message ? e.message : String(e)).toLowerCase()
    if (msg.includes('abort')) return { status: 'timeout', latencyMs }
    if (msg.includes('enotfound') || msg.includes('dns')) return { status: 'dns-error', latencyMs }
    if (msg.includes('econnrefused') || msg.includes('econnreset')) return { status: 'connection-error', latencyMs }
    // Any other transport failure: we never got an answer, so do not
    // claim the provider is unhealthy — say we could not reach it.
    return { status: 'connection-error', latencyMs, reason: msg.slice(0, 100) }
  }
}
