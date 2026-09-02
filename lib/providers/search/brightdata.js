// lib/providers/search/brightdata.js — POST https://api.brightdata.com/...
// Explicit-only. Requires the Bright Data "unlocker" zone header.

import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'brightdata'
export const ALL_ELIGIBLE = false

export async function providerSearch(query, numResults, apiKey, signal, options) {
  if (!apiKey) {
    throw toolError(
      'brightdata',
      'MISSING_API_KEY',
      'missing API key',
      "set BRIGHTDATA_API_KEY via /webdoctor-keys set brightdata <key> (credential ref: BRIGHTDATA_API_KEY), or pass $BRIGHTDATA_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const zone = (options && options.providerSpecific && options.providerSpecific.brightdataUnlockerZone) || 'unlocker'
  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      zone,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${numResults}`,
      format: { type: 'raw' },
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'brightdata',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  // Bright Data returns the raw HTML — for v1.0.0 we surface the URL of the
  // search query as a single "landing" source. A future pass can parse results
  // out of the HTML using Readability, but that crosses the fetch seam.
  const sources = [{
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    title: 'Bright Data unlocker: ' + query,
  }]
  return { sources, truncated: false, content: 'Use brightdata fetch via jina / firecrawl for parsed SERP.' }
}