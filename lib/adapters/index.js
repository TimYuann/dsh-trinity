// lib/adapters/index.js — adapter registry + matchSpecializedAdapter
// (SPEC §II.2 / §II.6).
//
// matchSpecializedAdapter(url) iterates every adapter EXCEPT genericHtml
// and returns the first one whose canHandle() accepts the URL. When no
// adapter matches, it returns `null` (NOT genericHtml — the fix for the
// 5.6 Pro routing dead-code path).
//
// genericHtml is the **content-type dispatch** target only. The
// chained-fetch.js content-type switch routes:
//   sniffed === 'pdf'  → pdfAdapter.fetch()
//   sniffed === 'html' → genericHtmlAdapter.fetch()
//   sniffed === 'text' → raw text return
//   sniffed === 'binary' → throw UNSUPPORTED_CONTENT_TYPE
//
// Acceptance #11 (content-type dispatch reachable) depends on this
// separation: a URL with no `.pdf` extension but Content-Type
// `application/pdf` must reach the PDF adapter through the dispatch path
// (NOT through matchSpecializedAdapter which would return null because
// the path doesn't end in `.pdf`).

import * as githubAdapter from './github.js'
import * as youtubeAdapter from './youtube.js'
import * as rssAdapter from './rss.js'
import * as pdfAdapter from './pdf.js'
// genericHtml is intentionally NOT imported here. It is mounted
// directly in chained-fetch.js for the content-type dispatch path.
import * as genericHtmlAdapter from './generic-html.js'

/**
 * Registry of specialised adapters. GenericHTML is excluded because
 * SPEC §II.2 nails its role: "GenericHTML is NOT a matchAdapter
 * fallback; it is a content-type dispatch target."
 *
 * @type {Array<{ id: string, canHandle: (url: string) => boolean, fetch: Function, tier?: number, cheap?: boolean, backends?: string[] }>}
 */
export const ADAPTERS = [githubAdapter, youtubeAdapter, rssAdapter, pdfAdapter]

/**
 * @param {string} url
 * @returns {any | null}
 */
export function matchSpecializedAdapter(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  for (const a of ADAPTERS) {
    if (!a || typeof a.canHandle !== 'function') continue
    if (a.canHandle(url)) return a
  }
  return null
}

/**
 * The content-type dispatch path's genericHtml target. Exposed so
 * chained-fetch.js can call into it after the matchAdapter fallback
 * returns null.
 */
export { genericHtmlAdapter }

// Re-export the matched adapters for type clarity.
export { githubAdapter, youtubeAdapter, rssAdapter, pdfAdapter }
