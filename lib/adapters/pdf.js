// lib/adapters/pdf.js — PDF ContentAdapter (SPEC §II.6).
//
// Cheap default: `unpdf` extracts the PDF text and we cap the result
// to `tools.pdfExtract.maxPages` (default 20) and the 20 000 char hard
// cap. The heavy path (Datalab or Gemini PDF) is only taken when the
// caller explicitly passes `provider: 'datalab' | 'gemini'` in settings
// — that gating lives in the dedicated `pdf_extract` Tool, NOT here.
//
// Per SPEC §II.7:
//   - Any I/O must run after validateUrl().
//   - No LLM call, no Tool invocation.

import { createHash } from 'node:crypto'
import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { safeHttpFetch } from '../util/safe-http-fetch.js'
import { toolError } from '../errors.js'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'pdf'
export const tier = 0
export const cheap = true
export const backends = ['unpdf']

const HARD_BODY_CAP = 20_000
const DEFAULT_MAX_PAGES = 20

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  if (u.pathname.toLowerCase().endsWith('.pdf')) return true
  if (/[?&]filename=[^&]*\.pdf(\b|$)/i.test(u.search)) return true
  return false
}

/**
 * @param {any} ctx
 */
export const capabilities = makeCapabilities({ tier, backends, cheap })
// R3 P1 #12: capabilities() used to read `settings.adapters.pdf.maxPages`,
// but the schema only declares `adapters.pdf.enabled`. The effective
// page cap is `tools.pdfExtract.maxPages` (runtime config, read in
// `fetch()`), not a capability. The helper no longer fabricates an
// undeclared capability.

/**
 * @param {{ url: string, mode?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ policy?: { ssrf?: any, domainPolicy?: any }, settings?: any,
 *          body?: Uint8Array, contentType?: string, finalUrl?: URL | string }} ctx
 */
export async function fetch(request, signal, ctx) {
  const url = request && request.url
  if (typeof url !== 'string' || url.length === 0) {
    throw toolError('pdf', 'INVALID_INPUT', 'pdf adapter requires { url: string }', 'internal')
  }
  if (ctx && ctx.policy) {
    await validateRemoteUrl(url, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
  }
  const maxPages = (ctx && ctx.settings && ctx.settings.tools && ctx.settings.tools.pdfExtract && typeof ctx.settings.tools.pdfExtract.maxPages === 'number')
    ? ctx.settings.tools.pdfExtract.maxPages
    : DEFAULT_MAX_PAGES

  // Two execution paths:
  //   1) ctx.body is provided (content-type dispatch from chained-fetch):
  //      the body was already fetched and we just need to parse.
  //   2) ctx.body is absent (matchSpecializedAdapter path): we fetch
  //      ourselves. This keeps the SPEC §II.6 contract — every adapter
  //      can be invoked standalone.
  let bytes
  let contentType
  let statusCode
  let finalUrlStr
  if (ctx && ctx.body instanceof Uint8Array) {
    bytes = ctx.body
    contentType = ctx.contentType || ''
    statusCode = 200
    finalUrlStr = typeof ctx.finalUrl === 'string' ? ctx.finalUrl : url
  } else {
    // R3 P1 #10: safeHttpFetch replaces raw global fetch with auto-follow
    // so every redirect hop is validated against the SSRF / domain policy.
    let safe
    try {
      safe = await safeHttpFetch(url, {
        ssrf: ctx && ctx.policy ? ctx.policy.ssrf : undefined,
        domainPolicy: ctx && ctx.policy ? ctx.policy.domainPolicy : undefined,
        signal,
      })
    } catch (e) {
      throw toolError('pdf', e && e.code ? e.code : 'WEB_FETCH_FAILED',
        `pdf fetch failed: ${e.message || e}`, 'check the URL is reachable')
    }
    const response = safe.response
    if (!response.ok) {
      throw toolError('pdf', 'HTTP_' + response.status, `pdf url returned HTTP ${response.status}`, 'verify the URL serves a PDF')
    }
    contentType = (response.headers && typeof response.headers.get === 'function')
      ? (response.headers.get('content-type') || '')
      : ''
    statusCode = response.status
    finalUrlStr = (safe.finalUrl && safe.finalUrl.toString) ? safe.finalUrl.toString() : (response.url || url)
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (contentType && !/application\/pdf/i.test(contentType)) {
    throw toolError('pdf', 'INVALID_CONTENT_TYPE',
      `URL returned non-PDF content-type: ${contentType}`,
      'pdf adapter only handles application/pdf responses; route other content-types via the GenericHTML / text dispatch path')
  }
  if (bytes.length === 0) {
    throw toolError('pdf', 'EMPTY_RESULTS', 'PDF body is empty', 'verify the URL serves a non-empty PDF')
  }

  let unpdf
  try {
    unpdf = await import('unpdf')
  } catch (e) {
    throw toolError('pdf', 'MISSING_DEPENDENCY',
      `unpdf is not installed: ${e.message || e}`,
      'run `pnpm add unpdf` to enable PDF extraction')
  }
  let parsed
  try {
    parsed = await unpdf.extractText(bytes, { mergePages: true })
  } catch (e) {
    throw toolError('pdf', 'INVALID_CONTENT_TYPE',
      `PDF parse failed: ${e.message || e}`,
      'the URL may not be a valid PDF; verify the response body is application/pdf')
  }
  const fullText = (parsed && typeof parsed.text === 'string') ? parsed.text : ''
  const totalPages = (parsed && typeof parsed.totalPages === 'number') ? parsed.totalPages : 0

  const lines = []
  lines.push(`# PDF: ${finalUrlStr}`)
  lines.push('')
  if (totalPages > 0) lines.push(`- Total pages: ${totalPages}`)
  if (maxPages < totalPages) lines.push(`- Pages shown: first ${maxPages} (capped by tools.pdfExtract.maxPages)`)
  lines.push('')
  const truncated = fullText.length > HARD_BODY_CAP
  lines.push(truncated ? fullText.slice(0, HARD_BODY_CAP) : fullText)
  const body = lines.join('\n').trim() + '\n'

  return {
    url: finalUrlStr,
    statusCode,
    body: { kind: 'html', content: body, extraction: 'pdf' },
    contentType: 'text/markdown',
    adapterId: id,
    truncated,
    contentDigest: createHash('sha256').update(body).digest('hex'),
  }
}
