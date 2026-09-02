// lib/errors.js — standard tool-error shape for LLM consumption (v2.0).
//
// PRINCIPLE (SPEC §II.8):
//   Every error has THREE parts so the model can adjust:
//     1. WHAT: human-readable description
//     2. CODE: stable machine-parseable code
//     3. TRY : concrete next-step advice
//
// v2.0 ADDS:
//   - WEB_SEARCH_CHAIN_EXHAUSTED (SPEC §II.3.3)
//   - WEB_CONTENT_FORBIDDEN (cache auth)
//   - WEB_CONTENT_NOT_FOUND / WEB_CONTENT_EXPIRED
//   - WEB_CONTENT_TOO_LARGE (hard cap)
//   - WEB_REDIRECT_BLOCKED, WEB_FETCH_FAILED, WEB_FETCH_JS_RENDERED

/**
 * Audit registry of legal error codes (SPEC §II.8). Flat string enum so
 * callers may add their own.
 */
export const TOOL_ERROR_CODES = Object.freeze({
  MISSING_API_KEY: 'MISSING_API_KEY',
  MISSING_CTX: 'MISSING_CTX',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  MISSING_ENV: 'MISSING_ENV',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_URL: 'INVALID_URL',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_CIDR: 'INVALID_CIDR',
  INVALID_JSON_CONFIG: 'INVALID_JSON_CONFIG',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  TOO_LARGE: 'TOO_LARGE',
  TOO_MANY: 'TOO_MANY',
  TOO_FEW: 'TOO_FEW',
  HTTP_BAD_REQUEST: 'HTTP_400',
  HTTP_UNAUTHORIZED: 'HTTP_401',
  HTTP_FORBIDDEN: 'HTTP_403',
  HTTP_NOT_FOUND: 'HTTP_404',
  HTTP_RATE_LIMITED: 'HTTP_429',
  HTTP_SERVER_ERROR: 'HTTP_5XX',
  EMPTY_RESULTS: 'EMPTY_RESULTS',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  HIDDEN_FILE: 'HIDDEN_FILE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  NOT_A_FILE: 'NOT_A_FILE',
  NOT_A_PDF: 'NOT_A_PDF',
  FILE_RESOLVE_FAIL: 'FILE_RESOLVE_FAIL',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  REDIRECT_BLOCKED: 'REDIRECT_BLOCKED',
  WEB_FETCH_ALL_FAILED: 'WEB_FETCH_ALL_FAILED',
  WEB_PROVIDER_BAD_REQUEST: 'WEB_PROVIDER_BAD_REQUEST',
  WEB_SEARCH_CHAIN_EXHAUSTED: 'WEB_SEARCH_CHAIN_EXHAUSTED',
  WEB_PROVIDER_ERROR: 'WEB_PROVIDER_ERROR',
  WEB_FETCH_FAILED: 'WEB_FETCH_FAILED',
  WEB_FETCH_TOO_LARGE: 'WEB_FETCH_TOO_LARGE',
  WEB_REDIRECT_BLOCKED: 'WEB_REDIRECT_BLOCKED',
  WEB_FETCH_JS_RENDERED: 'WEB_FETCH_JS_RENDERED',
  WEB_BLOCKED_URL: 'WEB_BLOCKED_URL',
  WEB_CONTENT_FORBIDDEN: 'WEB_CONTENT_FORBIDDEN',
  WEB_CONTENT_NOT_FOUND: 'WEB_CONTENT_NOT_FOUND',
  WEB_CONTENT_EXPIRED: 'WEB_CONTENT_EXPIRED',
  WEB_CONTENT_TOO_LARGE: 'WEB_CONTENT_TOO_LARGE',
  ABORTED: 'ABORTED',
  INTERNAL_BUG: 'INTERNAL_BUG',
})

/**
 * @param {string} tool
 * @param {string} code
 * @param {string} what
 * @param {string} advice
 * @param {{ cause?: unknown }} [opts]
 * @returns {Error & { tool: string, code: string, advice: string }}
 */
export function toolError(tool, code, what, advice, opts = {}) {
  if (!TOOL_ERROR_CODES[code] && !Object.values(TOOL_ERROR_CODES).includes(code)) {
    if (process.env.DSH_DEBUG) {
      console.warn(`[dsh-trinity] unregistered error code: ${code}`)
    }
  }
  const e = new Error(`[${tool}] ${what} | CODE: ${code} | TRY: ${advice}`)
  e.tool = tool
  e.code = code
  e.advice = advice
  if (opts.cause !== undefined) e.cause = opts.cause
  return /** @type {Error & { tool: string, code: string, advice: string }} */ (e)
}

/**
 * Alias for toolError — keeps callers short when the producer is the web
 * seam (no specific tool).
 *
 * @param {string} code
 * @param {string} what
 * @param {string} [advice]
 * @param {{ cause?: unknown }} [opts]
 */
export function webError(code, what, advice = 'see doctor / retry with a different provider', opts = {}) {
  return toolError('web', code, what, advice, opts)
}

/**
 * @param {number} status
 * @returns {{ code: string, label: string }}
 */
export function httpStatusToCode(status) {
  if (status === 400) return { code: TOOL_ERROR_CODES.HTTP_BAD_REQUEST, label: 'Bad Request' }
  if (status === 401) return { code: TOOL_ERROR_CODES.HTTP_UNAUTHORIZED, label: 'Unauthorized' }
  if (status === 403) return { code: TOOL_ERROR_CODES.HTTP_FORBIDDEN, label: 'Forbidden' }
  if (status === 404) return { code: TOOL_ERROR_CODES.HTTP_NOT_FOUND, label: 'Not Found' }
  if (status === 429) return { code: TOOL_ERROR_CODES.HTTP_RATE_LIMITED, label: 'Rate Limited' }
  if (status >= 500 && status < 600) return { code: TOOL_ERROR_CODES.HTTP_SERVER_ERROR, label: 'Server Error' }
  return { code: `HTTP_${status}`, label: `HTTP ${status}` }
}

/**
 * @param {string} tool
 * @param {unknown} cause
 * @param {string} advice
 */
export function wrapProviderError(tool, cause, advice) {
  const msg = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)
  const safe = msg && msg !== '[object Object]' ? msg.slice(0, 300) : '(no message)'
  return toolError(tool, 'PROVIDER_ERROR', `upstream error: ${safe}`, advice, { cause })
}
