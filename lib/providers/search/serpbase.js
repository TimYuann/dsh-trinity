// lib/providers/search/serpbase.js — POST https://api.serpbase.com/search
// Explicit-only.

import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'serpbase'
export const ALL_ELIGIBLE = false

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'serpbase',
      'MISSING_API_KEY',
      'missing API key',
      "set SERPBASE_API_KEY via /webdoctor-keys set serpbase <key> (credential ref: SERPBASE_API_KEY), or pass $SERPBASE_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.serpbase.com/search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: numResults }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'serpbase',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const results = Array.isArray(data.results) ? data.results : []
  const sources = results
    .filter((r) => r && typeof r.link === 'string' && r.link.length > 0)
    .map((r) => {
      const out = { url: r.link }
      if (r.title) out.title = String(r.title)
      if (r.snippet) out.snippet = String(r.snippet)
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'serpbase',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}