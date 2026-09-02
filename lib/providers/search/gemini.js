// lib/providers/search/gemini.js — POST generativelanguage.googleapis.com + grounding
import { toIso8601 } from '../../iso8601.js'
import { toolError, httpStatusToCode } from '../../errors.js'

// R3 P2 #20: removed the local HTTP_ADVICE map — classify-error.js /
// errors.js are the single source of provider advice.

export const PROVIDER_ID = 'gemini'
export const ALL_ELIGIBLE = true

export async function providerSearch(query, numResults, apiKey, signal, options) {
  const authMode = (options && options.providerSpecific && options.providerSpecific.geminiAuth) || 'apiKey'
  const model = (options && options.providerSpecific && options.providerSpecific.geminiModel) || 'gemini-2.5-flash'

  // ADC (Application Default Credentials) branch: when the operator
  // configures `geminiAuth: 'adc'`, we resolve the access token from the
  // standard metadata server (GCE / GKE / `gcloud auth application-default
  // login`). This lets Vertex AI work without a static API key.
  if (authMode === 'adc') {
    return runAdcBranch(query, numResults, model, signal)
  }

  // Default API-key branch
  if (!apiKey) {
    throw toolError(
      'gemini',
      'MISSING_API_KEY',
      'missing API key',
      "set GEMINI_API_KEY via /webdoctor-keys set gemini <key> (credential ref: GEMINI_API_KEY), or pass $GEMINI_API_KEY env var, or use a different provider (anysearch / gemini / brave) via web_search_ex(provider='...')",
    )
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError(
      'gemini',
      code,
      `upstream returned ${response.status} ${label}`,
      label,
      { cause: text.slice(0, 300) },
    )
  }
  const data = await response.json()
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const sources = []
  let answer = ''
  for (const cand of candidates) {
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : []
    for (const p of parts) {
      if (p && typeof p.text === 'string') answer += p.text
    }
    const grounding = cand && cand.groundingMetadata
    const chunks = grounding && Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []
    for (const c of chunks) {
      const w = c && c.web
      if (w && typeof w.uri === 'string' && w.uri.length > 0) {
        const out = { url: w.uri }
        if (w.title) out.title = String(w.title)
        sources.push(out)
      }
    }
  }
  // Slice & dedup
  const seen = new Set()
  const dedup = []
  for (const s of sources) {
    if (!seen.has(s.url)) { seen.add(s.url); dedup.push(s) }
  }
  const sliced = dedup.slice(0, numResults)
  if (sliced.length === 0) {
    throw toolError(
      'gemini',
      'EMPTY_RESULTS',
      'query returned 0 sources',
      "try a more specific or differently-phrased query, or use web_search_ex with mode='answer' to get a synthesized answer instead",
    )
  }
  return { sources: sliced, truncated: dedup.length > numResults, content: answer || undefined }
}

/**
 * ADC branch (Commit 3). Resolves an access token from the Google
 * metadata server (or `gcloud auth application-default login`) and
 * targets the Vertex AI endpoint instead of the public
 * generativelanguage API. Per SPEC §III.2 #3 the default behaviour
 * (apiKey mode) is unchanged when `geminiAuth !== 'adc'`.
 *
 * We do NOT call `gcloud`; we trust the standard GOOGLE_APPLICATION_CREDENTIALS
 * env var (or metadata server) and ask the official auth library. When
 * neither is present we throw a clear `CONFIG` error so the operator
 * knows what to set up.
 *
 * @param {string} query
 * @param {number} numResults
 * @param {string} model
 * @param {AbortSignal | undefined} signal
 */
async function runAdcBranch(query, numResults, model, signal) {
  // Lazy import: google-auth-library is an optional dependency for
  // operators who set geminiAuth: 'adc'. When it's missing we surface
  // a clear MISSING_DEPENDENCY error.
  let authClient
  try {
    const mod = await import('google-auth-library')
    const { GoogleAuth } = mod
    authClient = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  } catch (e) {
    throw toolError('gemini',
      'MISSING_DEPENDENCY',
      'google-auth-library is not installed (required for geminiAuth: "adc")',
      'run `pnpm add google-auth-library` to enable ADC mode, or set geminiAuth back to "apiKey" (default)')
  }
  let client
  try {
    client = await authClient.getClient()
  } catch (e) {
    throw toolError('gemini', 'CONFIG',
      `ADC auth setup failed: ${e.message || e}`,
      'run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>')
  }
  let token
  try {
    const headers = await client.getRequestHeaders()
    token = headers && headers.Authorization ? headers.Authorization.replace(/^Bearer\s+/i, '') : null
  } catch (e) {
    throw toolError('gemini', 'CONFIG',
      `ADC token fetch failed: ${e.message || e}`,
      'verify the ADC principal has access to Vertex AI / Gemini')
  }
  if (!token) {
    throw toolError('gemini', 'CONFIG',
      'ADC returned no access token',
      'verify the ADC principal has access to Vertex AI / Gemini')
  }
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
  if (!project) {
    throw toolError('gemini', 'CONFIG',
      'GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is not set',
      'set GOOGLE_CLOUD_PROJECT=<your-gcp-project> in the environment to use geminiAuth: "adc"')
  }
  // R3 P1 #15: region is configurable. Order: explicit option →
  // GEMINI_REGION env → GOOGLE_CLOUD_REGION env → 'us-central1' default.
  const region = (options && options.providerSpecific && options.providerSpecific.geminiRegion)
    || process.env.GEMINI_REGION
    || process.env.GOOGLE_CLOUD_REGION
    || 'us-central1'
  // Vertex AI endpoint shape (publisher model)
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
      }),
      signal,
    })
  } catch (e) {
    throw toolError('gemini', 'WEB_FETCH_FAILED', `gemini ADC fetch failed: ${e.message || e}`, 'check connectivity')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, label } = httpStatusToCode(response.status)
    throw toolError('gemini', code,
      `gemini ADC returned ${response.status} ${label}`,
      label,
      { cause: text.slice(0, 300) })
  }
  const data = await response.json()
  // Vertex AI returns the same `candidates[].groundingMetadata`
  // shape, but `groundingChunks[].web` is empty when google_search
  // grounding is not requested. We surface whatever the model returns.
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const sources = []
  for (const cand of candidates) {
    const chunks = cand && cand.groundingMetadata && Array.isArray(cand.groundingMetadata.groundingChunks) ? cand.groundingMetadata.groundingChunks : []
    for (const c of chunks) {
      const w = c && c.web
      if (w && typeof w.uri === 'string' && w.uri.length > 0) {
        const out = { url: w.uri }
        if (w.title) out.title = String(w.title)
        sources.push(out)
      }
    }
  }
  const seen = new Set()
  const dedup = []
  for (const s of sources) {
    if (!seen.has(s.url)) { seen.add(s.url); dedup.push(s) }
  }
  const sliced = dedup.slice(0, numResults)
  if (sliced.length === 0) {
    throw toolError('gemini', 'EMPTY_RESULTS',
      'gemini ADC returned 0 sources',
      'ADC mode does not enable google_search grounding by default; consider grounding via the public apiKey mode')
  }
  return { sources: sliced, truncated: dedup.length > numResults }
}