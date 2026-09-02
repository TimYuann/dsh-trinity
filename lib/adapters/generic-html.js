// lib/adapters/generic-html.js — GenericHTML ContentAdapter (SPEC §II.6).
//
// Locked extraction order (SPEC §II.6 / acceptance #12):
//   1. RSC flight script — detect & extract (Next.js / React Server Components)
//   2. @mozilla/readability — article extraction (chrome sites, blogs)
//   3. defuddle — content cleaning (cheerio-based) — falls back to the
//      in-house sanitizeHtml when defuddle is not installed (R1 stand-in)
//   4. sanitised raw HTML fallback — last resort
//
// RSC and Readability are no-ops when their respective inputs don't match;
// Defuddle strips scripts + ads + nav; the raw fallback preserves the body
// HTML for JS-rendered SPAs (caller can tell from isLikelyJSRendered).
//
// After extraction we run a `data:` URI sanitiser on the post-extraction
// body so unbounded RFC 2397 inline payloads do not land in the cache.

import { isRSCBody, extractRSCContent } from '../providers/fetch/rsc.js'
import { htmlToMarkdown, isLikelyJSRendered } from '../providers/fetch/readability.js'
import { sanitizeHtml } from '../providers/fetch/sanitize-html.js'
import { sanitizeDataUris } from '../providers/fetch/sanitize-data-uri.js'
import { createHash } from 'node:crypto'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'genericHtml'
export const tier = 0
export const cheap = true
export const backends = ['rsc-then-readability']

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  // The GenericHTML adapter is the content-type dispatch target for HTML,
  // not a matchAdapter fallback. It canHandle() is therefore intentionally
  // narrow — it matches only "obviously HTML" URLs by extension, since the
  // default dispatch happens after content-type sniff.
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    return /\.(html?|xhtml?)$/.test(path)
  } catch {
    return false
  }
}

export const capabilities = makeCapabilities({ tier, backends, cheap })

/**
 * Adapter fetch contract.
 *
 * The chained-fetch handler already fetched the response body and decoded
 * it; it then passes the bytes + charset through `ctx`. We do not re-fetch.
 *
 * @param {{ url: string, mode?: string }} _request
 * @param {AbortSignal | undefined} _signal
 * @param {{ body?: Uint8Array, charset?: string, contentType?: string, finalUrl?: URL | string, truncated?: boolean, policy?: any }} ctx
 */
export async function fetch(_request, _signal, ctx) {
  const body = (ctx && ctx.body) || null
  if (!body || !(body instanceof Uint8Array)) {
    throw new Error('generic-html adapter requires ctx.body to be a Uint8Array; the caller (safeFetch) is responsible for the fetch')
  }
  const charset = (ctx && ctx.charset) || 'utf-8'
  const decoder = new TextDecoder(charset)
  const html = decoder.decode(body)

  // ── 1. RSC detection (Next.js flight scripts) ────────────────────
  if (isRSCBody(html)) {
    const rsc = extractRSCContent(html)
    if (rsc && rsc.content && rsc.content.length > 200) {
      const data = sanitizeDataUris(rsc.content)
      // R3 P0 #3: every extraction path returns contentDigest so cache
      // keys + evidence snapshot refs are real SHA-256 (SPEC §II.3.4).
      return {
        url: typeof ctx.finalUrl === 'string' ? ctx.finalUrl : _request.url,
        statusCode: 200,
        body: { kind: 'html', content: data.text, extraction: 'rsc' },
        contentType: ctx.contentType || '',
        adapterId: id,
        truncated: !!ctx.truncated,
        contentDigest: createHash('sha256').update(data.text).digest('hex'),
        dataUris: { replaced: data.replaced, totalBytesRemoved: data.totalBytesRemoved },
      }
    }
  }

  // ── 2. @mozilla/readability ──────────────────────────────────────
  const md = await htmlToMarkdown(html)
  if (md && md.useful) {
    const data = sanitizeDataUris(md.markdown)
    return {
      url: typeof ctx.finalUrl === 'string' ? ctx.finalUrl : _request.url,
      statusCode: 200,
      body: { kind: 'html', content: data.text, extraction: 'readability' },
      contentType: ctx.contentType || '',
      adapterId: id,
      truncated: !!ctx.truncated,
      contentDigest: createHash('sha256').update(data.text).digest('hex'),
      dataUris: { replaced: data.replaced, totalBytesRemoved: data.totalBytesRemoved },
    }
  }

  // ── 3. defuddle (cheerio-based cleaning) ─────────────────────────
  // Prefer the real defuddle npm dep when installed; fall back to the
  // in-house sanitizeHtml (script + nav removal). Either way the output
  // is fed through sanitizeDataUris.
  let cleaned = null
  let defuddleSource = 'sanitize'
  try {
    const { Defuddle } = await import('defuddle')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM(html)
    const result = new Defuddle(dom, { markdown: true }).parse()
    if (result && typeof result.content === 'string' && result.content.length > 200) {
      cleaned = result.content
      defuddleSource = 'defuddle'
    }
  } catch (e) {
    // defuddle not installed — fall through to the in-house helper.
  }
  if (cleaned == null) {
    const s = sanitizeHtml(html)
    if (s && s.length > 200 && s.length < html.length) {
      cleaned = s
    }
  }
  if (cleaned != null) {
    const data = sanitizeDataUris(cleaned)
    // R3 P2 #19: explicit extraction id so debugging is unambiguous.
    const extraction = defuddleSource === 'defuddle' ? 'defuddle' : 'sanitize-html'
    return {
      url: typeof ctx.finalUrl === 'string' ? ctx.finalUrl : _request.url,
      statusCode: 200,
      body: { kind: 'html', content: data.text, extraction },
      contentType: ctx.contentType || '',
      adapterId: id,
      truncated: !!ctx.truncated,
      contentDigest: createHash('sha256').update(data.text).digest('hex'),
      dataUris: { replaced: data.replaced, totalBytesRemoved: data.totalBytesRemoved },
    }
  }

  // ── 4. raw HTML fallback ─────────────────────────────────────────
  // We never return empty content silently. If everything above was
  // useless AND the page looks like a JS-rendered SPA, surface a
  // UNSUPPORTED_CONTENT_TYPE so the model can decide what to do.
  // R3 P1 #11: WEB_FETCH_JS_RENDERED is now registered in classify-error.js
  // → 'invalid-response' (NOT 'unknown' / NOT auto-retry).
  if (isLikelyJSRendered(html)) {
    const e = new Error('Page appears to be JavaScript-rendered (empty body, many <script> tags)')
    e.code = 'WEB_FETCH_JS_RENDERED'
    e.class = 'invalid-response'
    throw e
  }
  const data = sanitizeDataUris(html)
  return {
    url: typeof ctx.finalUrl === 'string' ? ctx.finalUrl : _request.url,
    statusCode: 200,
    body: { kind: 'html', content: data.text, extraction: 'raw' },
    contentType: ctx.contentType || '',
    adapterId: id,
    truncated: !!ctx.truncated,
    contentDigest: createHash('sha256').update(data.text).digest('hex'),
    dataUris: { replaced: data.replaced, totalBytesRemoved: data.totalBytesRemoved },
  }
}
