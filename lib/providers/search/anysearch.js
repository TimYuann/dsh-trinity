// lib/providers/search/anysearch.js — POST https://api.anysearch.com/v1/search
// Explicit-only.

import { toolError, httpStatusToCode, wrapProviderError } from '../../errors.js'

export const PROVIDER_ID = 'anysearch'
export const ALL_ELIGIBLE = false

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

function httpAdviceFor(code, status, label) {
  return HTTP_ADVICE[code] || `unexpected HTTP ${status}: ${label}; switch providers or check provider docs`
}

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'anysearch',
      'MISSING_API_KEY',
      'missing API key',
      "set ANYSEARCH_API_KEY via /webdoctor-keys set anysearch <key> (credential ref: ANYSEARCH_API_KEY), or pass $ANYSEARCH_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.anysearch.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: numResults }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'anysearch',
      code,
      `upstream returned ${response.status} ${label}`,
      httpAdviceFor(code, response.status, label),
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  if (!data || data.code !== 0) {
    throw wrapProviderError(
      'anysearch',
      new Error('code=' + (data && data.code)),
      "anysearch returned a non-zero code — retry, or switch providers via web_search_ex(provider='brave' | 'gemini')",
    )
  }
  const results = data.data && Array.isArray(data.data.results) ? data.data.results : []
  const sources = results
    .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => {
      const out = { url: r.url }
      if (r.title) out.title = String(r.title)
      if (r.snippet) out.snippet = String(r.snippet)
      return out
    })
  if (sources.length === 0) {
    throw toolError(
      'anysearch',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources, truncated: results.length > numResults }
}
