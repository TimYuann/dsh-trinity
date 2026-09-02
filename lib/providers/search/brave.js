// lib/providers/search/brave.js — GET https://api.search.brave.com/res/v1/web/search
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'brave'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'brave',
      'MISSING_API_KEY',
      'missing API key',
      "set BRAVE_API_KEY via /webdoctor-keys set brave <key> (credential ref: BRAVE_API_KEY), or pass $BRAVE_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 20)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'brave',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const results = Array.isArray(data.web && data.web.results) ? data.web.results : []
  const sources = results
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (r.description) out.snippet = String(r.description)
      if (r.age) out.publishedAt = toIso8601(r.age) || undefined
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'brave',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}