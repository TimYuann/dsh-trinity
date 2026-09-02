// lib/providers/fetch/sanitize.js — backward-compatible shim (R3 P3 #25).
//
// The actual implementations live in:
//   - sanitize-html.js      (HTML script / SVG / event-handler removal)
//   - sanitize-data-uri.js  (RFC 2397 data: URI replacement)
//
// This file re-exports both so any existing caller (`import { sanitizeHtml,
// sanitizeDataUris } from '../providers/fetch/sanitize.js'`) keeps working.

export { sanitizeHtml } from './sanitize-html.js'
export { sanitizeDataUris } from './sanitize-data-uri.js'

import { sanitizeHtml as _sanitizeHtml } from './sanitize-html.js'
import { sanitizeDataUris as _sanitizeDataUris } from './sanitize-data-uri.js'

/**
 * Convenience: HTML + data: in one pass.
 *
 * @param {string} html
 */
export function sanitizeForCache(html) {
  if (typeof html !== 'string') return { text: '', html: { replaced: 0, totalBytesRemoved: 0 } }
  const htmlStep = _sanitizeHtml(html)
  const dataStep = _sanitizeDataUris(htmlStep)
  return {
    text: dataStep.text,
    html: { replaced: 0, totalBytesRemoved: 0 },
    data: { replaced: dataStep.replaced, totalBytesRemoved: dataStep.totalBytesRemoved },
  }
}