// lib/providers/fetch/chained-fetch.js — v2.0 full safeFetch (SPEC §II.2).
//
// matchSpecializedAdapter returns null when no specialised adapter matches
// (GenericHTML is NOT a matchAdapter fallback — that's the §II.2 fix for
// the routing dead-code path 5.6 Pro flagged).
//
// On null, content-type sniff dispatches to:
//   pdf     → pdfAdapter.fetch
//   html    → genericHtmlAdapter.fetch
//   text    → raw text return
//   binary  → UNSUPPORTED_CONTENT_TYPE

import { validateRemoteUrl, originKey, stripCredentialsOnCrossOrigin, authHeadersFor } from './url-policy.js'
import { getAuthFetchProfile, originAllowed } from '../../credentials/resolve.js'
import { classifyError, withClass } from '../../classify-error.js'

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const TEXT_TYPES = /^text\/|^application\/(json|ld\+json|xml|xhtml\+xml|javascript|x-javascript)(\b|$)|^\*\+json$|^\*\+xml$/i

/**
 * Cheap availability check (Node 18+ always exposes fetch).
 *
 * NOTE: SPEC §II.2 mandates the registered provider's `available()` ALWAYS
 * returns true; this helper is exposed for tests + diagnostics only.
 * The seam contract check that drives DSH's selection is the registered
 * provider's `available()`, not this helper.
 */
export function isChainedFetchAvailable() {
  return typeof fetch === 'function'
}

// ─────────────────────────────────────────────────────────────────────
// Adapter registry (R1 ships only GenericHTMLAdapter; specialised
// adapters land in Commit 3).
// ─────────────────────────────────────────────────────────────────────

import { matchSpecializedAdapter as matchSpecializedAdapterFromRegistry, genericHtmlAdapter, pdfAdapter as realPdfAdapter, rssAdapter as realRssAdapter } from '../../adapters/index.js'
import { createHash } from 'node:crypto'

// Re-import the PDF adapter for content-type dispatch. The PDF adapter
// is the dispatch target for sniffed.kind === 'pdf' (SPEC §II.2 / §II.6).
const PDF_ADAPTER = realPdfAdapter
// R3 P0 #2: RSS adapter is the dispatch target for sniffed.kind === 'rss'
// (SPEC §II.4 / §I.4 #10 — `application/rss+xml` & `application/atom+xml`
// & `text/xml` reachable through dispatch).
const RSS_ADAPTER = realRssAdapter

// ─────────────────────────────────────────────────────────────────────
// main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ url: string, mode?: string, authFetch?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ ssrf: any, domainPolicy: any, maxBytes: number, settings?: any, ctx?: any }} options
 */
export async function chainedFetch(request, signal, options) {
  const urlString = request && request.url
  if (typeof urlString !== 'string' || urlString.length === 0) {
    throw fetchError('INVALID_INPUT', 'chained-fetch: fetch requires { url: string }',
      'internal — fetch was called without a valid url string; the caller should pass { url: "https://..." }')
  }
  // SPEC §II.2 + P0 #1: safeFetch owns the "is anything usable?" decision
  // and returns NO_FETCH_RUNTIME when global fetch is unavailable.
  if (typeof fetch !== 'function') {
    throw fetchError('WEB_FETCH_FAILED',
      'NO_FETCH_RUNTIME: global fetch() is not available in this environment',
      'web_fetch requires Node 18+ (global fetch); upgrade Node or run inside a DSH environment with fetch enabled',
    )
  }
  const maxBytes = (options && options.maxBytes) ? options.maxBytes : 5 * 1024 * 1024

  // 1. matchSpecializedAdapter — returns null when no specialised adapter matches.
  // v2.3.0 § Commit 2.6: live `settings.adapters.*.enabled` filters which
  // adapters are reachable. When settings is undefined (unit-test path),
  // every adapter is matched (legacy behaviour).
  const specialized = matchSpecializedAdapterFromRegistry(urlString, options && options.settings)
  if (specialized) {
    await validateRemoteUrl(urlString, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })
    return safeInvokeAdapter(specialized, request, signal, ctxFromOptions(options))
  }

  // 2. SSRF preflight (validate the requested URL).
  await validateRemoteUrl(urlString, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })

  // 3. Content-Length preflight via HEAD (may be blocked; degrade gracefully).
  const headUrl = new URL(urlString)
  try {
    const headResp = await fetch(headUrl, { method: 'HEAD', redirect: 'follow', signal })
    const cl = headResp.headers.get('content-length')
    if (cl && Number(cl) > maxBytes) {
      throw fetchError('WEB_FETCH_TOO_LARGE',
        `Content-Length ${cl} exceeds cap ${maxBytes}`,
        'response exceeds fetchMaxResponseMB; reduce the file or use a streaming reader')
    }
  } catch (e) {
    if (e && e.code === 'WEB_FETCH_TOO_LARGE') throw e
  }

  // 4. Fetch with cross-Origin credential stripping (acceptance #6).
  const profile = resolveAuthProfile(request, options)
  const initialHeaders = profile ? {} : {}
  // For unauthenticated requests we leave headers empty; for authenticated
  // we add the credential in the first hop.
  let currentHeaders = profile ? authHeadersFor(profile, await readAuthValue(profile, options)) : initialHeaders

  const { url: finalUrl, response, redirectChain } = await fetchWithRedirects(headUrl, {
    method: 'GET',
    headers: currentHeaders,
  }, {
    maxBytes,
    signal,
    authProfile: profile,
    ssrf: options.ssrf,                // R3 P1 #13: thread policy for per-hop validation
    domainPolicy: options.domainPolicy,
    settingsCtx: options,
    getHeaders: () => currentHeaders,
    setHeaders: (h) => { currentHeaders = h },
  }, 0)

  const { bytes, truncated } = await readWithLimit(response, maxBytes, signal)
  const contentType = response.headers.get('content-type') || ''
  const charset = detectCharset(contentType)
  const kind = classifyContentType(contentType)

  // 5. Content-type dispatch — this is the path that was dead-code in v1.0.
  if (kind === 'pdf') {
    // Acceptance #11: a URL whose path does NOT end in `.pdf` but whose
    // Content-Type is application/pdf routes to the PDF adapter through
    // THIS dispatch path (NOT matchSpecializedAdapter which would have
    // returned null because the path doesn't end in `.pdf`).
    // v2.3.0 § Commit 2.6: honour live settings.adapters.pdf.enabled.
    if (!adapterGatedEnabled(options && options.settings, 'pdf')) {
      return adapterDisabledResponse(PDF_ADAPTER.id, contentType, finalUrl, response.status, redirectChain, truncated)
    }
    return safeInvokeAdapter(PDF_ADAPTER, request, signal, ctxFromOptions(options, { body: bytes, contentType, finalUrl, settings: options.settings }))
  }
  if (kind === 'rss') {
    // R3 P0 #2: `application/rss+xml`, `application/atom+xml`, and
    // `text/xml` reach the RSS adapter through this dispatch path so the
    // SPEC §I.4 #10 promise ("RSS URL → RSS adapter") holds even when
    // the URL doesn't carry a `.xml` / `.rss` / `.atom` extension.
    // We pass the raw bytes (no charset sniffing needed for XML) plus
    // the final URL so the adapter can record the resolved Origin.
    // v2.3.0 § Commit 2.6: honour live settings.adapters.rss.enabled.
    if (!adapterGatedEnabled(options && options.settings, 'rss')) {
      return adapterDisabledResponse(RSS_ADAPTER.id, contentType, finalUrl, response.status, redirectChain, truncated)
    }
    return safeInvokeAdapter(RSS_ADAPTER, request, signal, ctxFromOptions(options, { body: bytes, contentType, finalUrl, settings: options.settings }))
  }
  if (kind === 'html') {
    // v2.3.0 § Commit 2.6: honour live settings.adapters.genericHtml.enabled.
    if (!adapterGatedEnabled(options && options.settings, 'genericHtml')) {
      return adapterDisabledResponse('generic-html', contentType, finalUrl, response.status, redirectChain, truncated)
    }
    return safeInvokeAdapter(genericHtmlAdapter, request, signal, ctxFromOptions(options, { body: bytes, charset, contentType, finalUrl, truncated, settings: options.settings }))
  }
  if (kind === 'text') {
    const decoder = new TextDecoder(charset)
    const text = decoder.decode(bytes)
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body: { kind: 'text', content: text },
      contentType,
      contentDigest: digestBytes(bytes),
      truncated,
      adapterId: 'raw',
      redirectChain,
    }
  }
  if (kind === 'image' || kind === 'media' || kind === 'archive' || kind === 'binary') {
    throw fetchError('UNSUPPORTED_CONTENT_TYPE',
      `unsupported content type: ${contentType}`,
      `binary / media content (${contentType}) is not handled by safeFetch in v2.0; download manually`,
    )
  }
  if (kind === 'rss') {
    // Defensive: should already have routed above. Surfacing here as
    // UNSUPPORTED_CONTENT_TYPE keeps the error code table consistent.
    throw fetchError('UNSUPPORTED_CONTENT_TYPE',
      `unsupported rss content: ${contentType}`,
      'feed content could not be parsed')
  }
  throw fetchError('UNSUPPORTED_CONTENT_TYPE',
    `unsupported content type: ${contentType || 'unknown'}`,
    'content type is not text/html / text/* / json; if this is a JS-rendered SPA, try a different URL',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Specialized adapter matching (SPEC §II.2 — returns null, not GenericHTML).
// ─────────────────────────────────────────────────────────────────────

/**
 * Match a URL to a specialised ContentAdapter. Returns null when no
 * adapter's canHandle() accepts the URL. GenericHTML is NOT a matchAdapter
 * fallback — it's a content-type dispatch target (SPEC §II.2 / §II.6).
 *
 * Commit 3 (SPEC §II.6): the registry now contains github / youtube /
 * rss / pdf cheap variants. GenericHTML remains in the content-type
 * dispatch path (NOT in this list).
 *
 * @param {string} url
 * @returns {any | null}
 */
export function matchSpecializedAdapter(url, settings) {
  return matchSpecializedAdapterFromRegistry(url, settings)
}

// ─────────────────────────────────────────────────────────────────────
// Redirect chain with cross-Origin credential stripping.
// ─────────────────────────────────────────────────────────────────────

async function fetchWithRedirects(url, init, options, redirectDepth) {
  if (redirectDepth > MAX_REDIRECTS) {
    throw fetchError('WEB_REDIRECT_BLOCKED',
      `Too many redirects (max ${MAX_REDIRECTS})`,
      'redirect chain crossed origins or exceeded 5 hops; check the URL serves content directly without redirects',
    )
  }
  let response
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: options.signal })
  } catch (e) {
    throw fetchError('WEB_FETCH_FAILED',
      `fetch error: ${e.message || e}`,
      'network error during fetch; check connectivity or retry',
    )
  }
  if (!REDIRECT_CODES.has(response.status)) {
    return { url, response, redirectChain: buildRedirectChain(url, redirectDepth, []) }
  }
  const location = response.headers.get('location')
  if (!location) {
    throw fetchError('WEB_REDIRECT_BLOCKED',
      `Redirect without Location from ${url}`,
      'redirect chain crossed origins or exceeded 5 hops; check the URL serves content directly without redirects',
    )
  }
  const nextUrl = new URL(location, url)
  // R3 P1 #13: re-validate every hop against the SSRF + domain policy
  // (SPEC §II.7 — "Every redirect hop must re-validate"). A redirect to
  // a metadata endpoint or disallowed Origin now throws security.
  await validateRemoteUrl(nextUrl, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })
  // Cross-Origin credential stripping (acceptance #6).
  const profile = options.authProfile
  if (profile) {
    const r = stripCredentialsOnCrossOrigin(nextUrl, options.getHeaders() || {}, profile)
    options.setHeaders(r.headers)
    if (r.stripped) {
      // We continue without credentials on this hop.
    }
  }
  // 301/302/303 with non-GET/HEAD degrade to GET (strip body).
  let nextInit = { ...init }
  if (response.status === 301 || response.status === 302 || response.status === 303) {
    if (nextInit.method && nextInit.method.toUpperCase() !== 'GET' && nextInit.method.toUpperCase() !== 'HEAD') {
      nextInit.method = 'GET'
      delete nextInit.body
    }
  }
  return fetchWithRedirects(nextUrl, nextInit, options, redirectDepth + 1)
}

function buildRedirectChain(currentUrl, depth, acc) {
  if (depth === 0) return []
  acc.push(currentUrl.toString())
  return acc
}

// ─────────────────────────────────────────────────────────────────────
// Read response body with byte cap.
// ─────────────────────────────────────────────────────────────────────

async function readWithLimit(response, limitBytes, signal) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null
  if (!reader) {
    const text = await response.text()
    if (text.length > limitBytes) {
      throw fetchError('WEB_FETCH_TOO_LARGE',
        `Response too large (${Math.round(text.length / 1024 / 1024)}MB)`,
        'response exceeds fetchMaxResponseMB',
      )
    }
    return { bytes: new TextEncoder().encode(text), truncated: false }
  }
  const chunks = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limitBytes) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw fetchError('WEB_FETCH_TOO_LARGE',
        `Response too large (${Math.round(total / 1024 / 1024)}MB)`,
        'response exceeds fetchMaxResponseMB',
      )
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return { bytes: out, truncated: false }
}

function detectCharset(contentType) {
  if (typeof contentType !== 'string') return 'utf-8'
  const m = contentType.match(/charset=([^;\s]+)/i)
  return m ? m[1].toLowerCase() : 'utf-8'
}

/**
 * Classify content-type into one of the dispatch targets.
 *
 *   pdf     → PDF adapter
 *   rss     → RSS adapter (R3 P0 #2)
 *   html    → GenericHTML adapter
 *   text    → raw text return
 *   image   → UNSUPPORTED_CONTENT_TYPE (image is not handled in v2.0)
 *   media   → UNSUPPORTED_CONTENT_TYPE
 *   archive → UNSUPPORTED_CONTENT_TYPE
 *   binary  → UNSUPPORTED_CONTENT_TYPE
 *   unknown → UNSUPPORTED_CONTENT_TYPE
 *
 * @param {string} contentType
 */
export function classifyContentType(contentType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim()
  if (ct === 'application/pdf') return 'pdf'
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/octet-stream') return 'archive'
  if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'media'
  if (ct === 'application/zip' || ct === 'application/x-zip-compressed') return 'archive'
  // R3 P0 #2: RSS / Atom / XML dispatch (SPEC §I.4 #10). Without this,
  // a `/api/feed` URL whose path doesn't end in `.xml` and whose
  // Content-Type is `application/rss+xml` was falling through to
  // `binary` and throwing UNSUPPORTED_CONTENT_TYPE.
  if (ct === 'application/rss+xml' || ct === 'application/atom+xml' || ct === 'text/xml' || ct === 'application/xml') return 'rss'
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
  if (TEXT_TYPES.test(ct)) return 'text'
  return 'binary'
}

function digestBytes(bytes) {
  // P0 #5: SPEC §II.3.4 mandates SHA-256 hex. Use Node's built-in
  // node:crypto (imported at module top via `createHash`). Always
  // available in Node 18+, zero dependency cost.
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {any} settings
 * @param {string} id   — adapter id ('pdf' | 'rss' | 'genericHtml' | ...)
 * @returns {boolean}
 */
function adapterGatedEnabled(settings, id) {
  if (!settings) return true
  const slot = settings.adapters && settings.adapters[id]
  if (!slot || typeof slot !== 'object') return true
  return slot.enabled !== false
}

/**
 * Return a structured result when an adapter is gated off. The Tool
 * layer surfaces this as a normal "I fetched raw bytes" envelope so the
 * model still sees the bytes (and nothing parses / mutates them).
 */
function adapterDisabledResponse(adapterId, contentType, finalUrl, statusCode, redirectChain, truncated) {
  return {
    url: finalUrl.toString(),
    statusCode,
    body: { kind: 'text', content: '' },
    contentType,
    contentDigest: '',
    adapterId: `${adapterId}-disabled`,
    truncated,
    redirectChain,
    notes: `adapter '${adapterId}' is disabled in settings.adapters`,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Adapter invocation (canonical signature: fetch(request, signal, ctx)).
// ─────────────────────────────────────────────────────────────────────

function ctxFromOptions(options, extra = {}) {
  return {
    policy: { ssrf: options.ssrf, domainPolicy: options.domainPolicy },
    settings: options.settings,
    ctx: options.ctx,
    ...extra,
  }
}

/**
 * Invoke an adapter with the canonical signature, classify errors, and
 * normalise the return value to the v2.0 WebFetchResult shape.
 */
async function safeInvokeAdapter(adapter, request, signal, ctx) {
  try {
    const result = await adapter.fetch(request, signal, ctx)
    return normalizeAdapterResult(result, adapter.id, request.url)
  } catch (e) {
    const cls = classifyError(e)
    throw withClass(e, cls)
  }
}

function normalizeAdapterResult(result, adapterId, url) {
  if (!result || typeof result !== 'object') {
    throw new Error(`adapter ${adapterId} returned invalid result`)
  }
  // Allow adapters to return { url, statusCode, body: { kind, content }, contentType, contentDigest, adapterId }.
  return {
    url: typeof result.url === 'string' ? result.url : url,
    statusCode: typeof result.statusCode === 'number' ? result.statusCode : 200,
    body: result.body && typeof result.body === 'object' ? result.body : { kind: 'text', content: '' },
    contentType: typeof result.contentType === 'string' ? result.contentType : '',
    contentDigest: typeof result.contentDigest === 'string' ? result.contentDigest : '',
    adapterId: typeof result.adapterId === 'string' ? result.adapterId : adapterId,
    truncated: result.truncated === true,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth profile resolution + value lookup.
// ─────────────────────────────────────────────────────────────────────

function resolveAuthProfile(request, options) {
  if (!request || typeof request.authFetch !== 'string' || !request.authFetch) return undefined
  const settings = options && options.settings
  return getAuthFetchProfile(request.authFetch, settings)
}

async function readAuthValue(profile, options) {
  if (!profile || typeof profile.valueRef !== 'string') return ''
  const ctx = options && options.ctx
  if (!ctx || typeof ctx.get !== 'function') return ''
  const credentials = ctx.get('credentials')
  if (!credentials || typeof credentials.resolve !== 'function') return ''
  try {
    const r = await credentials.resolve({ key: profile.valueRef })
    if (r && typeof r === 'object' && typeof r.value === 'string') return r.value
  } catch {
    // ignore
  }
  return ''
}

// ─────────────────────────────────────────────────────────────────────
// Error helper (preserves the v1.0 contract shape).
// ─────────────────────────────────────────────────────────────────────

function fetchError(code, message, advice) {
  const e = new Error(`[web_fetch] ${message} | CODE: ${code} | TRY: ${advice}`)
  e.tool = 'web_fetch'
  e.code = code
  e.advice = advice
  e.name = 'WebError'
  return e
}

// Re-exports for downstream / tests.
export { originKey, stripCredentialsOnCrossOrigin, authHeadersFor, originAllowed }
