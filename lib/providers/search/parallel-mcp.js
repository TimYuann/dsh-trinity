// lib/providers/search/parallel-mcp.js — explicit-only Parallel Search MCP
// (Commit 3). Two modes:
//
//   1. Hosted fetch mode (preferred): the `parallel-mcp` remote endpoint
//      exposes a search MCP that this provider POSTs to with the query.
//      No API key required for the public surface; the operator may
//      configure `web-access-chain.parallelMcp.apiKey` for higher rate
//      limits.
//
//   2. Keyless fallback: if neither the endpoint nor the API key is
//      configured, the provider returns MISSING_DEPENDENCY.

import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

export const PROVIDER_ID = 'parallel-mcp'
export const ALL_ELIGIBLE = false // explicit-only per SPEC §II.3.3

// R3 P2 #20: removed the local ADVICE table — classify-error.js +
// errors.js are the single source of provider advice.

export async function providerSearch(query, numResults, apiKey, signal, options) {
  const cfg = (options && options.providerSpecific && options.providerSpecific.parallelMcp) || {}
  const endpoint = cfg.endpoint || 'https://api.parallel.ai/v1/search'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, max_results: numResults }),
      signal,
    })
  } catch (e) {
    throw toolError('parallel-mcp', 'WEB_FETCH_FAILED', `parallel-mcp fetch failed: ${e.message || e}`, 'check connectivity or switch provider')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError('parallel-mcp', code, `Parallel MCP returned HTTP ${response.status}: ${text.slice(0, 200)}`, label)
  }
  let payload
  try { payload = await response.json() } catch (e) {
    throw toolError('parallel-mcp', 'INVALID_RESPONSE', `Parallel MCP returned non-JSON: ${e.message || e}`, 'check provider response format')
  }
  const rawList = Array.isArray(payload && payload.results) ? payload.results
    : (Array.isArray(payload && payload.data) ? payload.data
    : (Array.isArray(payload) ? payload : []))
  if (rawList.length === 0) {
    throw toolError('parallel-mcp', 'EMPTY_RESULTS', 'Parallel MCP returned no results', 'try a different query or switch provider')
  }
  const sources = rawList.slice(0, numResults).map((r) => {
    const out = { url: r.url || r.link || '' }
    if (r.title) out.title = String(r.title)
    if (r.snippet || r.summary || r.excerpt) out.snippet = String(r.snippet || r.summary || r.excerpt)
    if (r.published_at || r.date) {
      const iso = toIso8601(r.published_at || r.date)
      if (iso) out.publishedAt = iso
    }
    return out
  }).filter((s) => s.url)
  if (sources.length === 0) {
    throw toolError('parallel-mcp', 'EMPTY_RESULTS', 'Parallel MCP returned items with no URLs', 'try a different query or switch provider')
  }
  return { sources, truncated: rawList.length > numResults }
}
