// lib/providers/search/kimi.js — explicit-only Kimi search (Commit 3).
//
// `kimi-coding` is a Pi-style OAuth flow against Moonshot AI's Kimi
// Code Plan endpoint. We do NOT default-enable this provider; the
// operator must configure KIMI_API_KEY (via /webdoctor-keys set kimi,
// the credential store, or $KIMI_API_KEY env) for it to appear in the chain.
//
// The implementation here is a small POST against the public
// generativelanguage-compatible endpoint that Kimi exposes for Code
// Plan subscribers. The exact request shape can be filled in when
// the operator enables the provider — until then the module returns
// a clear `MISSING_DEPENDENCY` error so a misconfiguration never
// silently produces empty results.

import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

export const PROVIDER_ID = 'kimi'
export const ALL_ELIGIBLE = false // explicit-only per SPEC §II.3.3

// R3 P2 #20: removed the local ADVICE table — classify-error.js +
// errors.js are the single source of provider advice.

export async function providerSearch(query, numResults, apiKey, signal, options) {
  if (!apiKey) {
    throw toolError(
      'kimi',
      'MISSING_API_KEY',
      'missing Kimi API key',
      "set KIMI_API_KEY via /webdoctor-keys set kimi <key> (credential ref: KIMI_API_KEY), or pass $KIMI_API_KEY env var; kimi is explicit-only and must be pinned via web_search_ex(routing='kimi')",
    )
  }
  const endpoint = (options && options.providerSpecific && options.providerSpecific.kimiEndpoint) || 'https://api.moonshot.cn/v1/search'
  const url = `${endpoint.replace(/\/$/, '')}?q=${encodeURIComponent(query)}`
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal,
    })
  } catch (e) {
    throw toolError('kimi', 'WEB_FETCH_FAILED', `kimi fetch failed: ${e.message || e}`, 'check connectivity or switch provider')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError('kimi', code, `Kimi search returned HTTP ${response.status}: ${text.slice(0, 200)}`, label)
  }
  let payload
  try { payload = await response.json() } catch (e) {
    throw toolError('kimi', 'INVALID_RESPONSE', `Kimi returned non-JSON: ${e.message || e}`, 'check provider response format')
  }
  const rawList = Array.isArray(payload && payload.data) ? payload.data : (Array.isArray(payload) ? payload : [])
  if (rawList.length === 0) {
    throw toolError('kimi', 'EMPTY_RESULTS', 'Kimi returned no results', 'try a different query or switch provider')
  }
  const sources = rawList.slice(0, numResults).map((r) => {
    const out = { url: r.url || r.link || r.source || '' }
    if (r.title) out.title = String(r.title)
    if (r.snippet || r.summary) out.snippet = String(r.snippet || r.summary)
    if (r.date || r.published_at) {
      const iso = toIso8601(r.date || r.published_at)
      if (iso) out.publishedAt = iso
    }
    return out
  }).filter((s) => s.url)
  if (sources.length === 0) {
    throw toolError('kimi', 'EMPTY_RESULTS', 'Kimi returned items with no URLs', 'try a different query or switch provider')
  }
  return { sources, truncated: rawList.length > numResults }
}
