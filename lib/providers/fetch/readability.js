// lib/providers/fetch/readability.js — linkedom + Readability + turndown (DESIGN §1.12)
//
// Defers linkedom / Readability / turndown imports so that the file can be
// loaded by tests / boot paths that don't actually have the deps installed
// yet. The first call to htmlToMarkdown() will throw a clear "missing dep"
// error if the packages aren't resolvable.

import { toolError } from '../../errors.js'

const MIN_USEFUL_CONTENT = 500

let linkedomMod = null
let readabilityMod = null
let turndownMod = null

function tryRequire(name) {
  try {
    // eslint-disable-next-line
    return require(name)
  } catch {
    return null
  }
}

async function importEsm(name) {
  try {
    const m = await import(name)
    return m
  } catch {
    return null
  }
}

async function ensureDeps() {
  if (linkedomMod && readabilityMod && turndownMod) return
  linkedomMod = tryRequire('linkedom') || (await importEsm('linkedom'))
  if (!linkedomMod) {
    throw toolError(
      'web_fetch',
      'MISSING_DEPENDENCY',
      'Missing dependency: linkedom',
      "reinstall dsh-trinity with 'pnpm install' or 'npm install --prefix <bundle>' to fetch the missing package; the dep is listed in our package.json",
    )
  }
  readabilityMod = tryRequire('@mozilla/readability') || (await importEsm('@mozilla/readability'))
  if (!readabilityMod) {
    throw toolError(
      'web_fetch',
      'MISSING_DEPENDENCY',
      'Missing dependency: @mozilla/readability',
      "reinstall dsh-trinity with 'pnpm install' or 'npm install --prefix <bundle>' to fetch the missing package; the dep is listed in our package.json",
    )
  }
  turndownMod = tryRequire('turndown') || (await importEsm('turndown'))
  if (!turndownMod) {
    throw toolError(
      'web_fetch',
      'MISSING_DEPENDENCY',
      'Missing dependency: turndown',
      "reinstall dsh-trinity with 'pnpm install' or 'npm install --prefix <bundle>' to fetch the missing package; the dep is listed in our package.json",
    )
  }
}

let turndownSingleton = null

async function getTurndown() {
  if (turndownSingleton) return turndownSingleton
  await ensureDeps()
  const TD = turndownMod.default || turndownMod.TurndownService || turndownMod
  turndownSingleton = new TD({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  })
  return turndownSingleton
}

/**
 * @param {string} html
 * @returns {{ document: any, title: string, declaredLinks: string[] }}
 */
export function parseHTMLDoc(html) {
  if (!linkedomMod) {
    // sync fast-fail when called without ensuring deps
    throw toolError(
      'web_fetch',
      'INTERNAL_BUG',
      'readability.js: linkedom not initialised',
      'internal plugin bug — call htmlToMarkdown(url) which auto-initializes deps, not the lower-level htmlToMarkdownRaw',
    )
  }
  const { document } = linkedomMod.parseHTML(html || '')
  const title = (document && document.title ? String(document.title).trim() : '') || ''
  const declaredLinks = collectDeclaredLinks(document)
  return { document, title, declaredLinks }
}

function collectDeclaredLinks(document) {
  const out = new Set()
  if (!document) return []
  try {
    const head = document.head
    if (head && typeof head.querySelectorAll === 'function') {
      for (const link of head.querySelectorAll('link[rel][href]')) {
        const rel = String(link.getAttribute('rel') || '').toLowerCase()
        if (['canonical', 'alternate', 'icon', 'stylesheet'].includes(rel)) {
          out.add(String(link.getAttribute('href')))
        }
      }
    }
    if (document.body && typeof document.body.querySelectorAll === 'function') {
      for (const a of document.body.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href')
        if (href) out.add(String(href))
      }
    }
  } catch { /* best effort */ }
  return Array.from(out)
}

/**
 * Convert an HTML string to readable markdown. Returns { markdown, useful }
 * where useful=false when the article is suspiciously short.
 *
 * @param {string} html
 * @param {{ minUsefulContentChars?: number }} [opts]
 * @returns {Promise<{ markdown: string, useful: boolean, title: string, declaredLinks: string[] }>}
 */
export async function htmlToMarkdown(html, opts) {
  const min = (opts && typeof opts.minUsefulContentChars === 'number') ? opts.minUsefulContentChars : MIN_USEFUL_CONTENT
  await ensureDeps()
  const { document, title, declaredLinks } = parseHTMLDoc(html)
  let article = null
  const Readability = readabilityMod.Readability || readabilityMod
  try {
    article = new Readability(document).parse()
  } catch { /* readability throws on pathological inputs */ }
  let markdown = ''
  let useful = true
  const td = await getTurndown()
  if (article && article.content) {
    markdown = td.turndown(article.content)
    if (markdown.length < min) useful = false
  } else {
    useful = false
  }
  if (declaredLinks && declaredLinks.length > 0) {
    const linkBlock = declaredLinks
      .filter((l) => typeof l === 'string' && (l.startsWith('http://') || l.startsWith('https://')))
      .slice(0, 50)
      .map((l) => `- ${l}`)
      .join('\n')
    if (linkBlock) markdown += `\n\n## Declared links\n${linkBlock}\n`
  }
  return { markdown, useful, title, declaredLinks }
}

/**
 * Heuristic JS-rendered check used when the readable conversion fails or
 * produces too little content.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isLikelyJSRendered(html) {
  if (typeof html !== 'string') return false
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const inner = bodyMatch ? bodyMatch[1] : html
  const stripped = inner.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '')
  const scriptCount = (inner.match(/<script\b/gi) || []).length
  return stripped.trim().length < 500 && scriptCount > 3
}