// lib/providers/search/searxng.js — POST $SEARXNG_HOST/search?q=... (no key)
// Mirrors pi-web-access searxng.ts; rewritten as plain ESM fetch.
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'searxng'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, host, signal) {
  if (!host) {
    throw toolError(
      'searxng',
      'MISSING_ENV',
      'missing SEARXNG_HOST',
      'set $SEARXNG_HOST env var to your self-hosted SearXNG instance URL (e.g. https://search.example.org), or use a different provider',
    )
  }
  const url = `${host.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'searxng',
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
    .slice(0, numResults)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (r.content) out.snippet = String(r.content)
      if (r.publishedDate) out.publishedAt = toIso8601(r.publishedDate) || undefined
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'searxng',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: false }
}