// lib/providers/search/exa.js — POST https://api.exa.ai/search
// v1.0.0 rewrite (was lib/exa.js in v0.1.0).
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'exa'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'exa',
      'MISSING_API_KEY',
      'missing API key',
      "set EXA_API_KEY via /webdoctor-keys set exa <key> (credential ref: EXA_API_KEY), or pass $EXA_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'x-exa-integration': 'dsh-trinity',
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults,
      contents: { text: true, highlights: true },
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'exa',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const sources = (Array.isArray(data.results) ? data.results : [])
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .slice(0, numResults)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (Array.isArray(r.highlights) && r.highlights[0]) out.snippet = String(r.highlights[0])
      if (r.publishedDate) out.publishedAt = toIso8601(r.publishedDate) || undefined
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'exa',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: (Array.isArray(data.results) ? data.results.length : 0) > numResults }
}