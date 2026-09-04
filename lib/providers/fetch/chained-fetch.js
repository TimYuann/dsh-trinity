// lib/providers/fetch/chained-fetch.js — content-type & adapter
// orchestration (v2.3.0 contract closure § Commit 3).
//
// chained-fetch is no longer a fetch implementation. The sole
// direct-HTTP transport lives in lib/util/safe-http-fetch.js; this
// module adapts its bounded envelope into the existing
// `WebFetchResult` shape and routes the result through the
// content-type dispatch.
//
// Direct-HTTP adapters (PDF, RSS, genericHtml) now receive bounded
// bytes from safeHttpFetch instead of loading the entire response
// body in memory; missing adapter bytes cannot escape this module.

import { classifyError, withClass } from '../../classify-error.js'
import { safeHttpFetch } from '../../util/safe-http-fetch.js'
import {
  validateRemoteUrl,
  originKey,
  stripCredentialsOnCrossOrigin,
  authHeadersFor,
} from './url-policy.js'
import {
  matchSpecializedAdapter as matchSpecializedAdapterFromRegistry,
  genericHtmlAdapter,
  pdfAdapter as realPdfAdapter,
  rssAdapter as realRssAdapter,
} from '../../adapters/index.js'
import { getAuthFetchProfile } from '../../credentials/resolve.js'

const PDF_ADAPTER = realPdfAdapter
const RSS_ADAPTER = realRssAdapter

const TEXT_TYPES = /^text\/|^application\/(json|ld\+json|xml|xhtml\+xml|javascript|x-javascript)(\b|$)|^\*\+json$|^\*\+xml$/i

export function isChainedFetchAvailable() {
  return typeof fetch === 'function'
}

export { safeHttpFetch }

/**
 * @param {{ url: string, mode?: string, authFetch?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ ssrf: any, domainPolicy: any, maxBytes: number, settings?: any, ctx?: any, dispatcherFactory?: (url: URL) => any }} options
 */
export async function chainedFetch(request, signal, options) {
  const urlString = request && request.url
  if (typeof urlString !== 'string' || urlString.length === 0) {
    throw fetchError('INVALID_INPUT', 'chained-fetch: fetch requires { url: string }',
      'internal — fetch was called without a valid url string; the caller should pass { url: "https://..." }')
  }
  if (typeof fetch !== 'function') {
    throw fetchError('WEB_FETCH_FAILED',
      'NO_FETCH_RUNTIME: global fetch() is not available in this environment',
      'web_fetch requires Node 18+ (global fetch); upgrade Node or run inside a DSH environment with fetch enabled')
  }
  const maxBytes = (options && options.maxBytes) ? options.maxBytes : 5 * 1024 * 1024

  // 1. Specialized adapter matching (the cheap path).
  const specialized = matchSpecializedAdapterFromRegistry(urlString, options && options.settings)
  if (specialized) {
    await validateRemoteUrl(urlString, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })
    return safeInvokeAdapter(specialized, request, signal, ctxFromOptions(options))
  }

  // 2. Sole direct-HTTP transport. safeHttpFetch owns:
  //      - initial SSRF / domain policy validation
  //      - manual redirect loop with per-hop validation + strip
  //      - byte cap with stream cancellation
  //      - abort propagation
  //      - string-credential ref resolution (no `{key:...}` wrapper)
  const authProfile = resolveAuthProfile(request, options)
  const result = await safeHttpFetch(urlString, {
    maxBytes,
    signal,
    ssrf: options.ssrf,
    domainPolicy: options.domainPolicy,
    authProfile,
    resolveCredential: authProfile ? makeCredentialResolver(authProfile, options) : undefined,
  })

  const charset = detectCharset(result.contentType)
  const kind = classifyContentType(result.contentType)

  // 3. Content-type dispatch. Honours live settings.adapters.*.enabled
  // gates so disabling a specialised adapter falls back to a raw-text
  // envelope rather than throwing.
  if (kind === 'pdf') {
    if (!adapterGatedEnabled(options && options.settings, 'pdf')) {
      return adapterDisabledResponse(PDF_ADAPTER.id, result, request.url)
    }
    return safeInvokeAdapter(PDF_ADAPTER, request, signal, ctxFromOptions(options, {
      body: result.bytes,
      contentType: result.contentType,
      finalUrl: result.finalUrl.toString(),
      settings: options.settings,
    }))
  }
  if (kind === 'rss') {
    if (!adapterGatedEnabled(options && options.settings, 'rss')) {
      return adapterDisabledResponse(RSS_ADAPTER.id, result, request.url)
    }
    return safeInvokeAdapter(RSS_ADAPTER, request, signal, ctxFromOptions(options, {
      body: result.bytes,
      contentType: result.contentType,
      finalUrl: result.finalUrl.toString(),
      settings: options.settings,
    }))
  }
  if (kind === 'html') {
    if (!adapterGatedEnabled(options && options.settings, 'genericHtml')) {
      return adapterDisabledResponse('generic-html', result, request.url)
    }
    return safeInvokeAdapter(genericHtmlAdapter, request, signal, ctxFromOptions(options, {
      body: result.bytes,
      charset,
      contentType: result.contentType,
      finalUrl: result.finalUrl.toString(),
      truncated: result.truncated,
      settings: options.settings,
    }))
  }
  if (kind === 'text') {
    const decoder = new TextDecoder(charset)
    const text = decoder.decode(result.bytes)
    return {
      url: result.finalUrl.toString(),
      statusCode: result.statusCode,
      body: { kind: 'text', content: text },
      contentType: result.contentType,
      contentDigest: digestBytes(result.bytes),
      adapterId: 'raw',
      truncated: result.truncated,
      redirectChain: result.redirectChain,
    }
  }
  if (kind === 'image' || kind === 'media' || kind === 'archive' || kind === 'binary') {
    throw fetchError('UNSUPPORTED_CONTENT_TYPE',
      `unsupported content type: ${result.contentType}`,
      `binary / media content (${result.contentType}) is not handled by safeFetch; download manually`)
  }
  throw fetchError('UNSUPPORTED_CONTENT_TYPE',
    `unsupported content type: ${result.contentType || 'unknown'}`,
    'content type is not text/html / text/* / json; if this is a JS-rendered SPA, try a different URL')
}

/**
 * @param {string} url
 * @param {any} [settings]
 */
export function matchSpecializedAdapter(url, settings) {
  return matchSpecializedAdapterFromRegistry(url, settings)
}

function ctxFromOptions(options, extra = {}) {
  return {
    policy: { ssrf: options.ssrf, domainPolicy: options.domainPolicy },
    settings: options.settings,
    ctx: options.ctx,
    ...extra,
  }
}

function adapterGatedEnabled(settings, id) {
  if (!settings) return true
  const slot = settings.adapters && settings.adapters[id]
  if (!slot || typeof slot !== 'object') return true
  return slot.enabled !== false
}

function adapterDisabledResponse(adapterId, result, requestUrl) {
  return {
    url: (result && result.finalUrl ? result.finalUrl.toString() : requestUrl),
    statusCode: (result && result.statusCode) || 200,
    body: { kind: 'text', content: '' },
    contentType: result && result.contentType ? result.contentType : '',
    contentDigest: '',
    adapterId: `${adapterId}-disabled`,
    truncated: !!(result && result.truncated),
    redirectChain: (result && result.redirectChain) || [],
    notes: `adapter '${adapterId}' is disabled in settings.adapters`,
  }
}

async function safeInvokeAdapter(adapter, request, signal, ctx) {
  try {
    const out = await adapter.fetch(request, signal, ctx)
    return normalizeAdapterResult(out, adapter.id, request.url)
  } catch (e) {
    const cls = classifyError(e)
    throw withClass(e, cls)
  }
}

function normalizeAdapterResult(result, adapterId, url) {
  if (!result || typeof result !== 'object') {
    throw new Error(`adapter ${adapterId} returned invalid result`)
  }
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

function detectCharset(contentType) {
  if (typeof contentType !== 'string') return 'utf-8'
  const m = contentType.match(/charset=([^;\s]+)/i)
  return m ? m[1].toLowerCase() : 'utf-8'
}

/**
 * Classify a content-type into a dispatch target.
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
  if (ct === 'application/rss+xml' || ct === 'application/atom+xml' || ct === 'text/xml' || ct === 'application/xml') return 'rss'
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
  if (TEXT_TYPES.test(ct)) return 'text'
  return 'binary'
}

import { createHash } from 'node:crypto'

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Resolve an authFetch profile to a credential resolver that takes a
 * string ref (per the v2.3.0 credentials seam).
 */
function resolveAuthProfile(request, options) {
  if (!request || typeof request.authFetch !== 'string' || !request.authFetch) return undefined
  const settings = options && options.settings
  return getAuthFetchProfile(request.authFetch, settings)
}

function makeCredentialResolver(profile, options) {
  const ctx = options && options.ctx
  return async (ref) => {
    if (!ctx || typeof ctx.get !== 'function' || typeof ref !== 'string') return undefined
    const credentials = ctx.get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') return undefined
    try {
      const r = await credentials.resolve(ref)
      if (r && typeof r === 'object' && typeof r.value === 'string') return r.value
      if (typeof r === 'string') return r
    } catch { /* ignore */ }
    return undefined
  }
}

function fetchError(code, message, advice) {
  const e = new Error(`[web_fetch] ${message} | CODE: ${code} | TRY: ${advice}`)
  e.tool = 'web_fetch'
  e.code = code
  e.advice = advice
  e.name = 'WebError'
  return e
}

export { originKey, stripCredentialsOnCrossOrigin, authHeadersFor }
