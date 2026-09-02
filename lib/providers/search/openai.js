// lib/providers/search/openai.js — POST api.openai.com/v1/responses + web_search tool
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

const HTTP_ADVICE = {
  HTTP_401: "API key may be invalid or expired — verify with the provider dashboard, then retry; or switch providers via web_search_ex(provider='brave' | 'gemini')",
  HTTP_403: 'key lacks required scope/permission for this endpoint — re-issue the key with proper permissions, or switch providers',
  HTTP_404: 'the API endpoint may have changed — check provider docs; or use a different provider',
  HTTP_429: "rate limited — wait ~60s and retry, or switch to a different provider via web_search_ex(provider='tavily' | 'brave')",
  HTTP_5XX: 'provider is having an outage — retry after a moment, or switch to a different provider',
}

export const PROVIDER_ID = 'openai'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal) {
  if (!apiKey) {
    throw toolError(
      'openai',
      'MISSING_API_KEY',
      'missing API key',
      "set OPENAI_API_KEY via /webdoctor-keys set openai <key> (credential ref: OPENAI_API_KEY), or pass $OPENAI_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: query,
      tools: [{ type: 'web_search' }],
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'openai',
      code,
      `upstream returned ${response.status} ${label}`,
      HTTP_ADVICE[code] || `unexpected HTTP ${response.status}: ${label}; switch providers or check provider docs`,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  // OpenAI Responses API: output_text + tool call outputs. We pull citations from
  // the web_search_call output item when present.
  const sources = []
  const outputs = Array.isArray(data.output) ? data.output : []
  for (const item of outputs) {
    if (item && item.type === 'web_search_call' && Array.isArray(item.results)) {
      for (const r of item.results) {
        if (r && typeof r.url === 'string' && r.url.length > 0) {
          const out = { url: r.url }
          if (r.title) out.title = String(r.title)
          sources.push(out)
        }
      }
    }
  }
  if (sources.length === 0) {
    throw toolError(
      'openai',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources: sources.slice(0, numResults), truncated: sources.length > numResults }
}