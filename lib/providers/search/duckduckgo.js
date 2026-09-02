// lib/providers/search/duckduckgo.js — GET https://html.duckduckgo.com/html/?q=...
// Explicit-only: no auth, but session cookies are helpful; v1.0.0 ships without cookie support.

import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'duckduckgo'
export const ALL_ELIGIBLE = false

export async function providerSearch(query, numResults, _apiKey, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; dsh-trinity/2.2.2)',
      'Accept': 'text/html',
    },
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'duckduckgo',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const html = await response.text()
  // Minimal HTML scraper — duckduckgo HTML mode wraps results in <a class="result__a" href="...">TITLE</a> with snippets.
  const sources = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) !== null && sources.length < numResults) {
    const url2 = m[1]
    if (!url2 || url2.length === 0) continue
    const title = m[2] ? m[2].replace(/<[^>]+>/g, '').trim() : ''
    const snippet = m[3] ? m[3].replace(/<[^>]+>/g, '').trim() : ''
    const out = { url: url2 }
    if (title) out.title = title
    if (snippet) out.snippet = snippet
    sources.push(out)
  }
  if (sources.length === 0) {
    throw toolError(
      'duckduckgo',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "this is a keyless provider; if the request still fails it may be IP/rate-limit blocked — switch to anysearch or brave",
    )
  }
  return { sources, truncated: false }
}