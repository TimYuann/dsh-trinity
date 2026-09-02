// lib/providers/search/firecrawl.js — POST https://api.firecrawl.dev/v1/search
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'firecrawl'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal, options) {
  if (!apiKey) {
    throw toolError(
      'firecrawl',
      'MISSING_API_KEY',
      'missing API key',
      "set FIRECRAWL_KEY via /webdoctor-keys set firecrawl <key> (credential ref: FIRECRAWL_KEY), or pass $FIRECRAWL_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const base = (options && options.providerSpecific && options.providerSpecific.firecrawlBaseUrl)
    || 'https://api.firecrawl.dev'
  const response = await fetch(`${base.replace(/\/$/, '')}/v1/search`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, limit: numResults }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'firecrawl',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const results = Array.isArray(data.data) ? data.data : []
  const sources = results
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (r.description) out.snippet = String(r.description)
      if (r.publishedAt) out.publishedAt = toIso8601(r.publishedAt) || undefined
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'firecrawl',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}