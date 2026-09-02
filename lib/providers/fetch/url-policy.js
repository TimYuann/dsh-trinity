// lib/providers/fetch/url-policy.js — cross-Origin credential stripping
// (SPEC §II.7 + acceptance #6).
//
// Re-export of v1.0's validateRemoteUrl + a new helper
// `stripCredentialsOnCrossOrigin` that safeFetch calls between redirect
// hops. When the previous URL's Origin is not in the authFetch profile's
// allowedOrigins list, we erase Authorization / Cookie / Proxy-Authorization
// from the forwarded init.headers.

import { validateRemoteUrl } from './ssrf.js'
import { originAllowed } from '../../credentials/resolve.js'

const AUTH_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
])

/**
 * Validate a URL for safe remote fetch. Thin re-export of v1.0's logic so
 * downstream modules import from a single path.
 */
export { validateRemoteUrl }

/**
 * Decide whether the credential headers in `init.headers` should be carried
 * forward to `nextUrl` (the next hop after a redirect). Per SPEC §II.7,
 * every redirect hop must re-validate; if the next URL's Origin is not in
 * the authFetch profile's allowedOrigins list, strip the credentials.
 *
 * @param {URL} nextUrl
 * @param {Record<string, string> | undefined} headers     current request headers
 * @param {{ name: string, allowedOrigins: string[] } | undefined} profile
 * @returns {{ headers: Record<string, string>, stripped: boolean, reason: string | null }}
 */
export function stripCredentialsOnCrossOrigin(nextUrl, headers, profile) {
  const safe = { ...(headers || {}) }
  if (!profile) return { headers: safe, stripped: false, reason: null }

  const nextOrigin = originKey(nextUrl)
  if (originAllowed(nextOrigin, profile.allowedOrigins)) {
    return { headers: safe, stripped: false, reason: null }
  }
  // Cross-Origin (or no allowed list match) → strip.
  const stripped = []
  for (const k of Object.keys(safe)) {
    if (AUTH_HEADERS.has(k.toLowerCase())) {
      delete safe[k]
      stripped.push(k)
    }
  }
  return {
    headers: safe,
    stripped: stripped.length > 0,
    reason: stripped.length > 0
      ? `cross-origin redirect to ${nextOrigin} stripped ${stripped.join(', ')}`
      : null,
  }
}

/**
 * Canonical "origin" key: scheme + host (no port normalisation, no path).
 * Used both for `Origin` header comparison and for matching the
 * allowedOrigins list.
 *
 * @param {URL} url
 * @returns {string}
 */
export function originKey(url) {
  if (!url || typeof url.origin !== 'string') return ''
  return url.origin
}

/**
 * Convenience: extract the headers that an authFetch profile should add to
 * a request, given the resolved credential value.
 *
 * @param {{ name: string, type: 'bearer' | 'basic' | 'cookie' }} profile
 * @param {string} value
 * @returns {Record<string, string>}
 */
export function authHeadersFor(profile, value) {
  if (!profile || !value) return {}
  if (profile.type === 'bearer') return { Authorization: `Bearer ${value}` }
  if (profile.type === 'basic') {
    // basic expects the raw user:pass (we don't btoa here; the runtime
    // btoa Builtin is reserved for callers who want pre-encoded values).
    return { Authorization: `Basic ${value}` }
  }
  if (profile.type === 'cookie') return { Cookie: value }
  return {}
}
