// lib/providers/search/valyu.js — POST https://api.valyu.ai/v1/search
// Explicit-only.

import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'valyu'
export const ALL_ELIGIBLE = false

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'valyu',
      'MISSING_API_KEY',
      'missing API key',
      "set VALYU_API_KEY via /webdoctor-keys set valyu <key> (credential ref: VALYU_API_KEY), or pass $VALYU_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.valyu.ai/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: Math.min(numResults, 20) }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'valyu',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const results = Array.isArray(data.results) ? data.results : []
  const sources = results
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (r.content) out.snippet = String(r.content).slice(0, 300)
      if (r.published_date) out.publishedAt = String(r.published_date)
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'valyu',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}