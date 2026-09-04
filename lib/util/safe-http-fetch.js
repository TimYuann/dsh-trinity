// lib/util/safe-http-fetch.js — the single direct-HTTP transport used by
// every adapter that needs to make an outbound HTTP request (SPEC §II.7,
// v2.3.0 contract closure § Commit 3).
//
// Responsibilities (one place, all of them):
//
//   1. Validate the initial URL against SSRF + domain policy.
//   2. Manual `redirect: 'manual'` redirect loop.
//   3. Per-hop URL policy validation (so a 30x to a private IP is rejected
//      before any second connection attempt).
//   4. Per-hop credential stripping on cross-Origin hops, with
//      credentials recomputed for every hop (no object aliasing).
//   5. String credential refs against the live credentials seam — no
//      `{ key: ... }` wrapper.
//   6. Hard byte cap with stream cancellation when the cap is exceeded.
//   7. Abort propagation through the supplied `signal`.
//
// There is **no HEAD preflight**, no second redirect implementation, and
// no separate fetch path. v2.3.0 § Commit 3 deletes the HEAD that used
// to live in chained-fetch (the review P0 #2.1 SSRF gap) instead of
// relocating it. The Content-Length check is performed on the FIRST
// hop's GET response header.
//
// The previous safeHttpFetch helper exposed `Response` to the caller.
// v2.3.0 returns a consumed, bounded envelope `{ finalUrl, statusCode,
// headers, bytes, redirectChain, contentType }` so callers (PDF, RSS,
// genericHtml adapters, source-check pipelines) cannot accidentally
// stream unbounded response bodies.

import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { stripCredentialsOnCrossOrigin } from '../providers/fetch/url-policy.js'

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

/**
 * @typedef {{
 *   authProfile?: { name?: string, type: 'bearer'|'basic'|'cookie', valueRef: string, allowedOrigins?: string[] },
 *   ssrf?: any,
 *   domainPolicy?: any,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 *   resolveCredential?: (valueRef: string) => Promise<string | undefined>,
 * }} SafeHttpOptions
 */

/**
 * @param {string | URL} url
 * @param {SafeHttpOptions} [options]
 * @returns {Promise<{
 *   finalUrl: URL,
 *   statusCode: number,
 *   headers: Headers,
 *   bytes: Uint8Array,
 *   redirectChain: string[],
 *   contentType: string,
 *   truncated: boolean,
 * }>}
 */
export async function safeHttpFetch(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new SafeHttpError('WEB_FETCH_FAILED',
      'NO_FETCH_RUNTIME: global fetch() is not available in this environment',
      'web_fetch requires Node 18+ (global fetch); upgrade Node or run inside a DSH environment with fetch enabled')
  }
  const maxBytes = (typeof options.maxBytes === 'number' && options.maxBytes > 0)
    ? options.maxBytes
    : 5 * 1024 * 1024

  const initial = url instanceof URL ? url : new URL(String(url))
  await validateRemoteUrl(initial, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })

  // Resolve credentials for the FIRST hop. We pass the resolved secret
  // value through; cross-Origin hops strip it via
  // stripCredentialsOnCrossOrigin and DO NOT carry it forward.
  let credentialValue
  if (options.authProfile && options.resolveCredential) {
    try {
      credentialValue = await options.resolveCredential(options.authProfile.valueRef)
    } catch { /* ignore */ }
  }
  const initialHopAccepted = isFirstHopOriginAllowed(initial, options.authProfile)
  let nextHeaders = (options.authProfile && initialHopAccepted && credentialValue)
    ? authHeaderFor(options.authProfile, credentialValue)
    : {}

  const chain = []
  let url_ = initial
  let response

  for (let depth = 0; depth <= MAX_REDIRECTS; depth++) {
    response = await fetch(url_, {
      method: 'GET',
      headers: nextHeaders,
      redirect: 'manual',
      signal: options.signal,
    })

    if (!REDIRECT_CODES.has(response.status)) break

    const location = response.headers.get('location')
    if (!location) {
      throw new SafeHttpError('WEB_REDIRECT_BLOCKED',
        `Redirect without Location from ${url_}`,
        'redirect chain crossed origins or exceeded 5 hops')
    }
    const nextUrl = new URL(location, url_)
    try { response.body && response.body.cancel && response.body.cancel() } catch { /* ignore */ }

    // Per-hop URL policy validation.
    await validateRemoteUrl(nextUrl, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })

    // Per-hop credential stripping. Cross-Origin strips sensitive
    // headers. We rebuild nextHopAllowedHeaders from the fresh profile
    // value so that no identity-aliasing bleeds through.
    if (options.authProfile) {
      const stripped = stripCredentialsOnCrossOrigin(nextUrl, nextHeaders, options.authProfile)
      const sameOrigin = (typeof originOf === 'function') ? stripped : stripped
      let nextHopHeaders = stripped.headers
      if (isNextHopOriginAllowed(nextUrl, options.authProfile)) {
        let nextHopValue
        try {
          nextHopValue = options.resolveCredential
            ? await options.resolveCredential(options.authProfile.valueRef)
            : undefined
        } catch { nextHopValue = undefined }
        // Same-Origin retries: re-add the credential (canonical refresh).
        if (nextHopValue) {
          nextHopHeaders = authHeaderFor(options.authProfile, nextHopValue)
        }
      }
      nextHeaders = nextHopHeaders
    } else {
      nextHeaders = nextHopAccepted ? nextHeaders : {}
    }

    chain.push(url_.toString())
    url_ = nextUrl
  }

  if (response && REDIRECT_CODES.has(response.status)) {
    try { response.body && response.body.cancel && response.body.cancel() } catch { /* ignore */ }
    throw new SafeHttpError('WEB_REDIRECT_BLOCKED',
      `Too many redirects (max ${MAX_REDIRECTS}) from ${url_}`,
      'redirect chain crossed origins or exceeded 5 hops')
  }

  // Body streaming with hard cap.
  const headers = response.headers
  const contentType = headers.get('content-type') || ''
  const declared = Number(headers.get('content-length') || 0)
  if (declared > 0 && declared > maxBytes) {
    try { response.body && response.body.cancel && response.body.cancel() } catch { /* ignore */ }
    throw new SafeHttpError('WEB_FETCH_TOO_LARGE',
      `Content-Length ${declared} exceeds cap ${maxBytes}`,
      'response exceeds maxBytes; reduce the file or use a streaming reader')
  }

  const { bytes, truncated } = await readCapped(response, maxBytes, options.signal)

  return {
    finalUrl: url_,
    statusCode: response.status,
    headers,
    bytes,
    redirectChain: chain,
    contentType,
    truncated,
  }
}

function isFirstHopOriginAllowed(url, profile) {
  return isNextHopOriginAllowed(url, profile)
}

function isNextHopOriginAllowed(url, profile) {
  if (!profile || !Array.isArray(profile.allowedOrigins) || profile.allowedOrigins.length === 0) {
    return false
  }
  const origin = originOf(url)
  for (const allowed of profile.allowedOrigins) {
    if (typeof allowed !== 'string') continue
    if (allowed === origin) return true
  }
  return false
}

function originOf(url) {
  return `${url.protocol}//${url.host}`
}

/**
 * Build the auth header for a profile. Basic credentials are
 * Base64-encoded here.
 */
function authHeaderFor(profile, value) {
  if (!profile || !value || typeof value !== 'string' || value.length === 0) return {}
  switch (profile.type) {
    case 'bearer':
      return { Authorization: `Bearer ${value}` }
    case 'basic': {
      const encoded = Buffer.from(value, 'utf8').toString('base64')
      return { Authorization: `Basic ${encoded}` }
    }
    case 'cookie':
      return { Cookie: value }
    default:
      return {}
  }
}

/**
 * Stream the response body up to maxBytes + 1; cancel the stream
 * immediately when the cap is exceeded.
 */
async function readCapped(response, maxBytes, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new SafeHttpError('WEB_FETCH_TOO_LARGE',
        `Response too large (${Math.round(text.length / 1024 / 1024)}MB)`,
        'response exceeds maxBytes')
    }
    return { bytes: new TextEncoder().encode(text), truncated: false }
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      if (signal && signal.aborted) {
        try { reader.cancel() } catch { /* ignore */ }
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { reader.cancel() } catch { /* ignore */ }
        throw new SafeHttpError('WEB_FETCH_TOO_LARGE',
          `Response too large (${Math.round(total / 1024 / 1024)}MB)`,
          'response exceeds maxBytes')
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return { bytes: out, truncated: false }
}

export class SafeHttpError extends Error {
  constructor(code, message, advice) {
    super(`[safe_http_fetch] ${message} | CODE: ${code} | TRY: ${advice}`)
    this.name = 'SafeHttpError'
    this.code = code
    this.advice = advice
    this.tool = 'safe_http_fetch'
  }
}
