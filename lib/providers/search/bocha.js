// lib/providers/search/bocha.js — POST https://api.bochaai.com/v1/web-search
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'bocha'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'bocha',
      'MISSING_API_KEY',
      'missing API key',
      "set BOCHA_API_KEY via /webdoctor-keys set bocha <key> (credential ref: BOCHA_API_KEY), or pass $BOCHA_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      count: Math.min(numResults, 20),
      summary: false,
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'bocha',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const results = Array.isArray(data.data && data.data.webPages) ? data.data.webPages : []
  const sources = results
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => {
      const out = { url: r.url }
      if (r.name) out.title = String(r.name)
      if (r.snippet) out.snippet = String(r.snippet)
      if (r.dateLastCrawled) out.publishedAt = toIso8601(r.dateLastCrawled) || undefined
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'bocha',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}