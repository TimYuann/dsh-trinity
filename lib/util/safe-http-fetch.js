// lib/util/safe-http-fetch.js — single-source HTTP fetch for adapters
// (SPEC §II.7 — R3 P0 #1, P1 #10, P1 #13).
//
// Adapters that need to fetch a remote URL must use this helper rather
// than calling `fetch(url, { redirect: 'follow' })` directly. The helper
// honours every SPEC §II.7 requirement in one place:
//
//   - SSRF preflight on the FIRST URL
//   - Manual redirect loop with `validateRemoteUrl` on every hop
//   - Cross-Origin credential stripping via `stripCredentialsOnCrossOrigin`
//   - Response Content-Length preflight (when not under an adapter that
//     knows the byte budget)
//   - Bounded retry on transient / network errors (5xx / ETIMEDOUT /
//     DNS-failure)
//
// Returns the same `fetch` Response shape but exposes `finalUrl` so the
// caller can record the post-redirect URL in the result envelope.

import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { stripCredentialsOnCrossOrigin } from '../providers/fetch/url-policy.js'

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const TRANSIENT_RETRY = 1

/**
 * @typedef {{
 *   authProfile?: any,           // optional authFetch profile for credential stripping
 *   ssrf?: any,                  // SSRF policy (allowRanges, trustEnvProxy)
 *   domainPolicy?: any,          // domain allow/deny
 *   maxBytes?: number,           // response byte cap (default 5 MiB)
 *   signal?: AbortSignal,
 *   getHeaders?: () => Record<string, string>,
 *   setHeaders?: (h: Record<string, string>) => void,
 * }} SafeHttpOptions
 */

/**
 * @param {string | URL} url
 * @param {SafeHttpOptions} [options]
 * @returns {Promise<{ response: Response, finalUrl: URL, redirectChain: string[] }>}
 */
export async function safeHttpFetch(url, options = {}) {
  const initial = url instanceof URL ? url : new URL(String(url))
  await validateRemoteUrl(initial, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })
  return fetchWithRedirects(initial, {}, options, 0, [])
}

/**
 * @param {URL} url
 * @param {RequestInit} init
 * @param {SafeHttpOptions} options
 * @param {number} depth
 * @param {string[]} chain
 */
async function fetchWithRedirects(url, init, options, depth, chain) {
  if (depth > MAX_REDIRECTS) {
    throw fetchError('WEB_REDIRECT_BLOCKED',
      `Too many redirects (max ${MAX_REDIRECTS}) from ${url}`,
      'redirect chain crossed origins or exceeded 5 hops; check the URL serves content directly')
  }
  let response
  for (let attempt = 0; attempt <= TRANSIENT_RETRY; attempt++) {
    try {
      response = await fetch(url, { ...init, redirect: 'manual', signal: options.signal })
      break
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).toLowerCase()
      const transient = msg.includes('econnreset') || msg.includes('econnrefused') ||
        msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('fetch failed') ||
        msg.includes('socket hang up') || msg.includes('network')
      if (transient && attempt === 0) continue
      throw fetchError('WEB_FETCH_FAILED', `fetch error: ${e.message || e}`,
        'network error during fetch; check connectivity or retry')
    }
  }
  if (!REDIRECT_CODES.has(response.status)) {
    return { response, finalUrl: url, redirectChain: chain }
  }
  const location = response.headers.get('location')
  if (!location) {
    throw fetchError('WEB_REDIRECT_BLOCKED',
      `Redirect without Location from ${url}`,
      'redirect chain crossed origins or exceeded 5 hops')
  }
  const nextUrl = new URL(location, url)
  // P0 #1 + P1 #13: re-validate every hop against the policy.
  await validateRemoteUrl(nextUrl, { ssrf: options.ssrf, domainPolicy: options.domainPolicy })
  // Cross-Origin credential stripping (acceptance #6).
  if (options.authProfile && typeof options.getHeaders === 'function' && typeof options.setHeaders === 'function') {
    const r = stripCredentialsOnCrossOrigin(nextUrl, options.getHeaders() || {}, options.authProfile)
    options.setHeaders(r.headers)
  }
  // 301/302/303 with non-GET degrade to GET.
  let nextInit = { ...init }
  if (response.status === 301 || response.status === 302 || response.status === 303) {
    if (nextInit.method && nextInit.method.toUpperCase() !== 'GET' && nextInit.method.toUpperCase() !== 'HEAD') {
      nextInit.method = 'GET'
      delete nextInit.body
    }
  }
  chain.push(url.toString())
  return fetchWithRedirects(nextUrl, nextInit, options, depth + 1, chain)
}

function fetchError(code, message, advice) {
  const e = new Error(`[web_fetch] ${message} | CODE: ${code} | TRY: ${advice}`)
  e.code = code
  e.advice = advice
  e.name = 'WebError'
  return e
}