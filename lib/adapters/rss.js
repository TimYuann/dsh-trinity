// lib/adapters/rss.js — RSS / Atom ContentAdapter (SPEC §II.6).
//
// Feedparser-style parse: fetch the feed (RSS 2.0 or Atom 1.0), extract
// channel metadata + entries with links. We do NOT fetch the entry
// links — they are returned to the caller (the model) which can then
// issue follow-up web_fetch calls if it wants the article body.
//
// Per SPEC §II.7:
//   - "RSS Adapter discovered links are new URLs — re-validate against
//     policy before fetching any." We surface the validation result
//     in each entry's `validatedAgainstPolicy` field.

import { createHash } from 'node:crypto'
import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { safeHttpFetch } from '../util/safe-http-fetch.js'
import { toolError } from '../errors.js'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'rss'
export const tier = 0
export const cheap = true
export const backends = ['feedparser', 'native']

const BODY_CAP = 20_000

// Path-shape heuristic — many feeds live under /rss, /feed, /atom.
// Per SPEC §II.6 canHandle is "pure" — it only inspects the URL.
const FEED_PATH_RE = /\/(rss|feed|atom|index\.(rss|xml|atom))(\.xml)?(\?|$|\/)/i

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  if (FEED_PATH_RE.test(u.pathname)) return true
  if (u.pathname.toLowerCase().endsWith('.xml')) return true
  if (u.pathname.toLowerCase().endsWith('.rss')) return true
  if (u.pathname.toLowerCase().endsWith('.atom')) return true
  if (/[?&](feed|rss|atom)=/i.test(u.search)) return true
  return false
}

/**
 * @param {any} _ctx
 */
export const capabilities = makeCapabilities({ tier, backends, cheap })

/**
 * @param {{ url: string, mode?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ policy?: { ssrf?: any, domainPolicy?: any } }} ctx
 */
export async function fetch(request, signal, ctx) {
  const url = request && request.url
  if (typeof url !== 'string' || url.length === 0) {
    throw toolError('rss', 'INVALID_INPUT', 'rss adapter requires { url: string }', 'internal')
  }
  if (ctx && ctx.policy) {
    await validateRemoteUrl(url, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
  }

  // Two execution paths (mirrors pdf.js):
  //   1) ctx.body is provided (content-type dispatch from chained-fetch):
  //      bytes are already on hand, parse directly.
  //   2) ctx.body absent (matchSpecializedAdapter path): we fetch via
  //      safeHttpFetch.
  let response = null
  let text = ''
  if (ctx && ctx.body instanceof Uint8Array) {
    const decoder = new TextDecoder('utf-8')
    text = decoder.decode(ctx.body)
  } else {
    // R3 P0 #1 + P1 #13: use safeHttpFetch (manual redirect loop with
    // per-hop validateRemoteUrl) instead of raw global fetch with auto-follow.
    let safe
    try {
      safe = await safeHttpFetch(url, {
        ssrf: ctx && ctx.policy ? ctx.policy.ssrf : undefined,
        domainPolicy: ctx && ctx.policy ? ctx.policy.domainPolicy : undefined,
        signal,
      })
    } catch (e) {
      throw toolError('rss', e && e.code ? e.code : 'WEB_FETCH_FAILED',
        `rss fetch failed: ${e.message || e}`, 'check the feed URL is reachable')
    }
    response = safe.response
    if (!response.ok) {
      throw toolError('rss', 'HTTP_' + response.status, `rss feed returned HTTP ${response.status}`, 'verify the URL is a valid feed')
    }
    text = await response.text()
  }

  const isAtom = /<feed[\s>]/i.test(text) && /xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(text)
  const isRss = /<rss[\s>]/i.test(text)
  if (!isAtom && !isRss) {
    throw toolError('rss', 'INVALID_CONTENT_TYPE',
      'URL is reachable but content is neither RSS 2.0 nor Atom 1.0',
      'verify the URL is a valid feed')
  }

  const channel = isAtom ? parseAtomChannel(text) : parseRssChannel(text)
  const entries = isAtom ? parseAtomEntries(text) : parseRssEntries(text)

  // Per SPEC §II.7: re-validate discovered links. We DO NOT fetch them;
  // we only mark whether each link passes the URL policy. The model can
  // then decide which to follow.
  // R3 P2 #21: validatedAgainstPolicy is now attached PER ENTRY, not in
  // a separate "Links blocked by policy" block at the end.
  const linkPolicy = ctx && ctx.policy ? ctx.policy : {}
  const sliced = entries.slice(0, 50)
  const decorated = []
  for (const e of sliced) {
    let validatedAgainstPolicy = false
    if (e.link) {
      try {
        await validateRemoteUrl(e.link, { ssrf: linkPolicy.ssrf, domainPolicy: linkPolicy.domainPolicy })
        validatedAgainstPolicy = true
      } catch { validatedAgainstPolicy = false }
    }
    decorated.push({ ...e, validatedAgainstPolicy })
  }

  const lines = []
  lines.push(`# ${channel.title || 'RSS Feed'}`)
  lines.push('')
  lines.push(`Source: ${url}`)
  if (channel.subtitle) { lines.push(''); lines.push(channel.subtitle) }
  if (channel.link) { lines.push(''); lines.push(`Home: ${channel.link}`) }
  lines.push('')
  lines.push(`## Entries (${entries.length})`)
  lines.push('')
  for (const e of decorated) {
    const title = e.title || '(untitled)'
    const date = e.published ? ` (${e.published})` : ''
    const link = e.link || ''
    const policyTag = link ? (e.validatedAgainstPolicy ? '' : ' [blocked-by-policy]') : ''
    if (link) lines.push(`- [${title}](${link})${date}${policyTag}`)
    else lines.push(`- ${title}${date}`)
    if (e.summary) lines.push(`  ${e.summary.slice(0, 200).replace(/\n/g, ' ')}`)
  }
  if (entries.length > 50) {
    lines.push('')
    lines.push(`(${entries.length - 50} more entries truncated)`)
  }
  const body = lines.join('\n').trim() + '\n'

  return {
    url,
    statusCode: response ? response.status : 200,
    body: { kind: 'html', content: body.slice(0, BODY_CAP), extraction: 'rss' },
    contentType: 'text/markdown',
    adapterId: id,
    truncated: body.length > BODY_CAP,
    contentDigest: createHash('sha256').update(body).digest('hex'),
  }
}

// ─────────────────────────────────────────────────────────────────────
// Minimal native parsers — no npm dependency. We only need what the
// Tool layer surfaces to the model; the model issues follow-up fetches
// when it wants the article body.
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} xml
 */
function parseRssChannel(xml) {
  return {
    title: tagText(xml, 'rss', 'title') || tagText(xml, 'channel', 'title'),
    link: tagHref(xml, 'rss', 'link') || tagHref(xml, 'channel', 'link') || tagText(xml, 'channel', 'link'),
    subtitle: tagText(xml, 'channel', 'description'),
  }
}

/**
 * @param {string} xml
 */
function parseRssEntries(xml) {
  const items = splitTopLevel(xml, 'item')
  return items.map((item) => ({
    title: tagText(item, 'item', 'title'),
    link: tagHref(item, 'item', 'link') || tagText(item, 'item', 'link'),
    published: tagText(item, 'item', 'pubDate') || tagText(item, 'item', 'date'),
    summary: tagText(item, 'item', 'description'),
  })).filter((e) => e.title || e.link)
}

/**
 * @param {string} xml
 */
function parseAtomChannel(xml) {
  return {
    title: tagText(xml, 'feed', 'title'),
    link: atomFeedLink(xml),
    subtitle: tagText(xml, 'feed', 'subtitle'),
  }
}

/**
 * @param {string} xml
 */
function parseAtomEntries(xml) {
  const ents = splitTopLevel(xml, 'entry')
  return ents.map((e) => {
    const m = e.match(/<link[^>]*?href=["']([^"']+)["']/i)
    return {
      title: tagText(e, 'entry', 'title'),
      link: m ? m[1] : '',
      published: tagText(e, 'entry', 'published') || tagText(e, 'entry', 'updated'),
      summary: tagText(e, 'entry', 'summary') || tagText(e, 'entry', 'content'),
    }
  }).filter((e) => e.title || e.link)
}

/**
 * @param {string} xml
 */
function atomFeedLink(xml) {
  const m = xml.match(/<link[^>]*?rel=["']alternate["'][^>]*?href=["']([^"']+)["']/i)
  if (m) return m[1]
  return tagHref(xml, 'feed', 'link') || tagText(xml, 'feed', 'link')
}

/**
 * @param {string} xml
 * @param {string} tag
 */
function tagText(xml, _parent, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return ''
  let v = m[1]
  v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  v = v.replace(/<[^>]+>/g, '').trim()
  return v
}

/**
 * @param {string} xml
 * @param {string} tag
 */
function tagHref(xml, _parent, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?\\bhref=["']([^"']+)["'][^>]*?(?:\\/>|>.*?</${tag}>)`, 'i')
  const m = xml.match(re)
  return m ? m[1] : ''
}

/**
 * @param {string} xml
 * @param {string} tag
 */
function splitTopLevel(xml, tag) {
  const out = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let m
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}
