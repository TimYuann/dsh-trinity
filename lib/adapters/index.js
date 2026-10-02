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
import * as xAdapter from './x.js'
// genericHtml is intentionally NOT imported here. It is mounted
// directly in chained-fetch.js for the content-type dispatch path.
import * as genericHtmlAdapter from './generic-html.js'

/**
 * Registry of specialised adapters. GenericHTML is excluded because
 * SPEC §II.2 nails its role: "GenericHTML is NOT a matchAdapter
 * fallback; it is a content-type dispatch target."
 *
 * @type {Array<{ id: string, canHandle: (url: string) => boolean, fetch: Function, tier?: number, cheap?: boolean, backends?: string[], requireExplicitOptIn?: boolean }>}
 */
export const ADAPTERS = [githubAdapter, youtubeAdapter, rssAdapter, pdfAdapter, xAdapter]

/**
 * Determine whether the given adapter id is currently enabled in the
 * live settings. v2.3.0 § Commit 2.6: missing or falsy → treat as
 * enabled (no operator override) so a freshly installed profile
 * behaves identically to its default.
 *
 * The `requireExplicitOptIn` exception is a CONSENT gate, not a
 * default value. An adapter that drives the operator's own logged-in
 * browser must not be reachable through the "missing means enabled"
 * rule: a stale profile, a direct caller, or a path that bypassed the
 * schema would all enable it. For those adapters only a literal
 * `enabled === true` counts.
 *
 * @param {any} settings
 * @param {{ id: string, requireExplicitOptIn?: boolean }} adapter
 */
function adapterEnabled(settings, adapter) {
  const id = adapter.id
  if (adapter.requireExplicitOptIn === true) {
    const a = settings && settings.adapters
    const slot = a && typeof a === 'object' ? a[id] : null
    return !!(slot && typeof slot === 'object' && slot.enabled === true)
  }
  if (!settings) return true
  const a = settings.adapters
  if (!a || typeof a !== 'object') return true
  const slot = a[id]
  if (!slot || typeof slot !== 'object') return true
  return slot.enabled !== false
}

/**
 * @param {string} url
 * @param {any} [settings]  — live settings (optional). When supplied,
 *   adapters whose `settings.adapters.<id>.enabled === false` are
 *   skipped before canHandle is called. When omitted (legacy callers),
 *   every adapter is matched — except opt-in adapters, which stay off.
 * @returns {any | null}
 */
export function matchSpecializedAdapter(url, settings) {
  if (typeof url !== 'string' || url.length === 0) return null
  for (const a of ADAPTERS) {
    if (!a || typeof a.canHandle !== 'function') continue
    if (!adapterEnabled(settings, a)) continue
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
export { githubAdapter, youtubeAdapter, rssAdapter, pdfAdapter, xAdapter }
