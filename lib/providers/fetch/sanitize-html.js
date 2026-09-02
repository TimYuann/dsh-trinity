// lib/providers/fetch/sanitize-html.js — HTML sanitiser (R3 P3 #25
// split-out).
//
// Defuddle-stand-in: removes scripts, styles, noscript, comments, SVGs,
// and inline event handlers. Used by GenericHTMLAdapter's step 3
// when defuddle is not installed.

const SCRIPT_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi
const STYLE_RE = /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi
const NOSCRIPT_RE = /<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi
const COMMENT_RE = /<!--[\s\S]*?-->/g
const SVG_RE = /<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi
const INLINE_EVENT_RE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi

/**
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  let out = html
  out = out.replace(SCRIPT_RE, '')
  out = out.replace(STYLE_RE, '')
  out = out.replace(NOSCRIPT_RE, '')
  out = out.replace(COMMENT_RE, '')
  out = out.replace(SVG_RE, '')
  out = out.replace(INLINE_EVENT_RE, '')
  return out.trim()
}