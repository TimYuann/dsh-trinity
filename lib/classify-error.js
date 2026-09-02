// lib/classify-error.js — Unified error classification (SPEC §II.8).
//
// Single source of truth for "what kind of error is this?". Consumed by:
//   - lib/credentials/pool.js — to drive the per-credential decision table
//   - lib/providers/search/chained.js — to decide next-provider vs throw
//   - lib/providers/fetch/chained-fetch.js — to decide retry vs throw
//   - lib/commands/webdoctor.js — to report `lastErrorClass` per provider
//
// The output is one of the locked classes from §II.8:
//
//   transient | quota | network | invalid-response | auth | credential
//   | config | invalid-request | aborted | security | budget
//
// Anything we cannot classify falls through to 'unknown', which the chain
// treats as a non-fallback error (the original v1 behaviour).

/** @typedef {'transient' | 'quota' | 'network' | 'invalid-response' | 'auth' | 'credential' | 'config' | 'invalid-request' | 'aborted' | 'security' | 'budget' | 'unknown'} ErrorClass */

export const ERROR_CLASSES = Object.freeze([
  'transient', 'quota', 'network', 'invalid-response', 'auth',
  'credential', 'config', 'invalid-request', 'aborted', 'security',
  'budget', 'unknown',
])

/**
 * @param {unknown} err
 * @returns {ErrorClass}
 */
export function classifyError(err) {
  if (!err) return 'unknown'

  // AbortError takes priority — it is the only signal that should propagate
  // verbatim through the chain (SPEC §II.3.3 "abort → abort entire chain").
  if (err && typeof err === 'object' && err.name === 'AbortError') return 'aborted'
  if (err && typeof err === 'object' && err.name === 'CanceledError') return 'aborted'
  if (err && typeof err === 'object' && err.code === 'ABORT_ERR') return 'aborted'
  const msg = (err && typeof err === 'object' && typeof err.message === 'string')
    ? err.message.toLowerCase()
    : (typeof err === 'string' ? err.toLowerCase() : '')
  if (msg.includes('abort')) return 'aborted'

  // Already classified (some upstream layer may have produced an explicit
  // class string). Trust it when it matches our registry.
  if (err && typeof err === 'object' && typeof err.class === 'string') {
    if (ERROR_CLASSES.includes(err.class)) return /** @type {ErrorClass} */ (err.class)
  }
  // Honour WebError codes from lib/errors.js / the web seam.
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    const c = String(err.code)
    if (c === 'WEB_PROVIDER_BAD_REQUEST' || c === 'WEB_INVALID_URL' || c === 'HTTP_400') return 'invalid-request'
    if (c === 'WEB_BLOCKED_URL' || c === 'SSRF_BLOCKED') return 'security'
    if (c === 'WEB_REDIRECT_BLOCKED') return 'security'
    if (c === 'WEB_PROVIDER_CONFIGURED_MISSING' || c === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE') return 'config'
    if (c === 'MISSING_API_KEY' || c === 'MISSING_CTX' || c === 'MISSING_ENV' || c === 'CREDENTIAL_EMPTY') return 'credential'
    if (c === 'INVALID_CIDR' || c === 'INVALID_JSON_CONFIG') return 'config'
    // R3 P1 #11: WEB_FETCH_JS_RENDERED is registered here so the chain
    // treats it as `invalid-response` (NOT auto-retry on a different
    // provider — JS rendering is a content problem, not a transient
    // failure).
    if (c === 'WEB_FETCH_JS_RENDERED') return 'invalid-response'
  }

  // Substring detection — order matters; more specific patterns first.
  // SECURITY: SSRF / cross-Origin credential leak. Throw, do not fallback.
  if (msg.includes('ssrf') || msg.includes('cross-origin') || msg.includes('cross origin')) return 'security'

  // CONFIG: schema / ADC / proxy misconfig. Throw.
  if (msg.includes('invalid json config') || msg.includes('failed to parse')) return 'config'
  if (msg.includes('adc') && (msg.includes('misconfig') || msg.includes('not configured'))) return 'config'
  if (msg.includes('proxy') && msg.includes('required')) return 'config'

  // CREDENTIAL: env var / placeholder / missing key. Try next credentialRef.
  if (
    msg.includes('credential') ||
    msg.includes('placeholder') ||
    msg.includes('missing api key') ||
    msg.includes('missing searxng_host') ||
    msg.includes('missing host')
  ) return 'credential'

  // QUOTA: 429 / quota / spending-limit / RESOURCE_EXHAUSTED.
  if (msg.includes('quota') || msg.includes('429')) return 'quota'
  if (msg.includes('spending-limit') || msg.includes('spending_limit')) return 'quota'
  if (msg.includes('resource_exhausted') || msg.includes('rate limit')) return 'quota'
  if (msg.includes('rate-limit') || msg.includes('ratelimit')) return 'quota'
  if (msg.includes('too many requests')) return 'quota'

  // AUTH: 401/403 (when not quota).
  if (msg.includes(' 401') || msg.startsWith('401') || msg.includes('http 401')) return 'auth'
  if (msg.includes(' 403') || msg.startsWith('403') || msg.includes('http 403')) return 'auth'
  if (msg.includes('unauthorized')) return 'auth'
  if (msg.includes('forbidden') && !msg.includes('quota')) return 'auth'

  // INVALID-REQUEST: 400.
  if (msg.includes(' 400') || msg.startsWith('400') || msg.includes('http 400')) return 'invalid-request'
  if (msg.includes('bad request') || msg.includes('invalid request')) return 'invalid-request'

  // INVALID-RESPONSE: parse fail / empty sources.
  if (msg.includes('invalid json') || msg.includes('json.parse') || msg.includes('parse')) return 'invalid-response'
  if (msg.includes('empty') || msg.includes('no results')) return 'invalid-response'

  // NETWORK: connection refused / DNS / connect.
  if (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up')
  ) return 'network'

  // TRANSIENT: HTTP 5xx (default for plain "5xx" messages).
  if (msg.includes('http 5') || msg.includes(' 5') && msg.includes('xx')) return 'transient'
  if (msg.includes('503') || msg.includes('502') || msg.includes('500') ||
      msg.includes('504') || msg.includes('service unavailable') ||
      msg.includes('bad gateway') || msg.includes('internal server error') ||
      msg.includes('gateway timeout')) return 'transient'

  return 'unknown'
}

/**
 * Action: should we retry this key once before moving on? (SPEC §II.3.3
 * decision table — only `transient` and `network` retry inside the key.)
 *
 * @param {ErrorClass} cls
 * @returns {boolean}
 */
export function isKeyRetryable(cls) {
  return cls === 'transient' || cls === 'network'
}

/**
 * Action: should we move on to the next credential / next provider? (Only
 * for the "fallback" classes; `auth`, `config`, `security`, `budget`,
 * `aborted`, `invalid-request` throw instead of fallback.)
 *
 * @param {ErrorClass} cls
 * @returns {boolean}
 */
export function isFallbackable(cls) {
  return cls === 'transient' ||
    cls === 'quota' ||
    cls === 'network' ||
    cls === 'invalid-response' ||
    cls === 'credential'
}

/**
 * Action: should this error mark the credential as `quotaCooldown`?
 * Returns the recommended cooldown in ms (60s default; Retry-After wins
 * when present).
 *
 * @param {ErrorClass} cls
 * @param {unknown} err
 * @returns {number | null}
 */
export function quotaCooldownMs(cls, err) {
  if (cls !== 'quota') return null
  const ra = extractRetryAfterMs(err)
  return ra !== null ? ra : 60_000
}

/**
 * @param {unknown} err
 * @returns {number | null}
 */
function extractRetryAfterMs(err) {
  if (!err || typeof err !== 'object') return null
  // Standard HTTP header
  if (err.headers && typeof err.headers === 'object') {
    const h = err.headers
    const raw = h['retry-after'] || h['Retry-After'] || h['x-ratelimit-reset']
    if (typeof raw === 'string' || typeof raw === 'number') {
      const v = String(raw).trim()
      if (/^\d+$/.test(v)) return Number(v) * 1000
      const t = Date.parse(v)
      if (!isNaN(t)) return Math.max(0, t - Date.now())
    }
  }
  // Some providers attach retryAfter / retryAfterMs directly
  if (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs)) {
    return Math.max(0, err.retryAfterMs)
  }
  if (typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter)) {
    return Math.max(0, err.retryAfter) * 1000
  }
  return null
}

/**
 * Wrap an error with an explicit `class` field so downstream code can
 * avoid re-classifying. Mutates a clone; never touches the original.
 *
 * @param {unknown} err
 * @param {ErrorClass} cls
 * @returns {Error}
 */
export function withClass(err, cls) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err))
  try {
    Object.defineProperty(e, 'class', { value: cls, writable: false, enumerable: false, configurable: false })
  } catch {
    /** @type {any} */ (e).class = cls
  }
  return e
}
