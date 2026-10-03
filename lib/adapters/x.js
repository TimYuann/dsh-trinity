// lib/adapters/x.js — X/Twitter timeline adapter (OpenCLI browser bridge).
//
// ── PHASE A SCOPE ────────────────────────────────────────────────────
// User timeline ONLY (`x.com/<user>`). Single-tweet `/status/` URLs are
// DELIBERATELY not matched: they already resolve through the genericHtml
// content-type path (publish.x.com/oembed), and taking that route over
// would trade a working capability for an unverified one. Search, lists
// and threads are deferred.
//
// ── SECURITY MODEL ───────────────────────────────────────────────────
// `opencli twitter` exposes 46 subcommands, 25 of which are WRITES
// (post/delete/like/follow/block/reply/retweet/bookmark/...). web_fetch
// means "read a URL". Therefore:
//
//   1. The subcommand token is a LITERAL taken from a frozen table. No
//      byte of the request URL can ever reach argv[2]. A URL may only
//      contribute a strictly-validated username, and only into a fixed
//      argument slot.
//   2. `parseTarget()` is the SINGLE pure parser serving both
//      canHandle() and fetch(), so the two cannot drift apart.
//   3. Both the ORIGINAL url and the CANONICAL x.com target must satisfy
//      the URL policy before anything is spawned. (twitter.com may be
//      allowed while x.com is denied — opencli visits x.com regardless,
//      so validating only the request URL would be a policy bypass.)
//   4. The frozen map defends against a hostile *URL*. It does NOT prove
//      the OpenCLI implementation is read-only: opencli lets a user
//      adapter under ~/.opencli/clis override its built-ins, so the code
//      actually executed is a LOCAL trust input, not a URL input. We
//      record provenance (version + override presence) and say so,
//      rather than claim a guarantee we cannot make.
//
// ── EXECUTION ────────────────────────────────────────────────────────
//   - Opt-in only: `settings.adapters.x.enabled === true` (strict).
//   - One browser fetch at a time (serialised), bounded by a total
//     deadline covering spawn, connect, navigate, execute and cleanup.
//   - Degradation to the public HTTP path is LIMITED to an explicit
//     allowlist of backend-unavailable reasons. Invalid input, policy
//     denials, user aborts and budget exhaustion are never swallowed.

import { createHash } from 'node:crypto'
import { runSubprocess } from '../util/subprocess.js'
import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { classifyError, withClass } from '../classify-error.js'
import { toolError } from '../errors.js'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'x'
export const tier = 0
export const cheap = false
export const backends = ['opencli']

/**
 * This adapter is NOT enabled by the generic `enabled !== false` rule.
 * It requires a literal `enabled === true` in settings — see
 * lib/adapters/index.js::adapterEnabled. A schema default alone is not a
 * gate: missing settings, missing `adapters`, or a missing `x` slot all
 * take other paths into the registry.
 */
export const requireExplicitOptIn = true

/**
 * This adapter may ask the fetch chain for a controlled public-HTTP
 * fallback (chained-fetch injects `ctx.publicFetch` only when this flag
 * is set). It never performs HTTP itself: the transport, redirect
 * handling, SSRF policy, byte cap and content-type dispatch stay owned
 * by chained-fetch, which also removes any x.js → chainedFetch → x.js
 * recursion risk.
 */
export const usesPublicFetch = true

// ── Frozen command surface ───────────────────────────────────────────

/** The literal subcommand used for a timeline read. Never derived. */
export const TIMELINE_VERB = 'tweets'

/** Verbs this adapter is permitted to reach. Frozen. */
export const READ_ONLY_VERBS = Object.freeze([TIMELINE_VERB])

/**
 * Subcommands of `opencli twitter` whose `--help` marks them `[write]`.
 * Kept here so a test can assert read/write disjointness, and so the
 * surface is visible at the point of use rather than in a doc.
 */
export const WRITE_VERBS = Object.freeze([
  'accept', 'block', 'bookmark', 'delete', 'follow', 'follow-batch',
  'hide-reply', 'like', 'list-add', 'list-add-batch', 'list-create',
  'list-delete', 'list-remove', 'list-remove-batch', 'login', 'post',
  'quote', 'reply', 'reply-dm', 'retweet', 'unblock', 'unbookmark',
  'unfollow', 'unlike', 'unretweet',
])

/** Hosts accepted as X/Twitter. Exact match only — never suffix match. */
const X_HOSTS = Object.freeze(new Set([
  'x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
]))

/** The host opencli actually navigates to, regardless of alias used. */
const CANONICAL_HOST = 'x.com'

/**
 * Single-segment paths that are SITE ROUTES, not usernames. Matching one
 * of these as a profile would spawn a useless browser read.
 */
const RESERVED_SEGMENTS = Object.freeze(new Set([
  'home', 'explore', 'notifications', 'messages', 'settings', 'i',
  'search', 'compose', 'login', 'logout', 'signup', 'intent', 'share',
  'hashtag', 'bookmarks', 'lists', 'following', 'followers', 'account',
  'about', 'tos', 'privacy', 'jobs', 'topics', 'connect_redirect',
]))

/** X handles: 1-15 word chars. Excludes every shell metacharacter. */
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/

const MAX_URL_LENGTH = 2048

// ── Bounds ───────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

// The host's own budget, not ours to exceed.
//
// @deepseek-ai/dsh-tool-web attaches `ToolDefinition.timeoutMs =
// fetchTimeoutMs` (default 30000) to web_fetch, and
// @deepseek-ai/dsh-tool-call-timeout-policy enforces it as a HARD abort
// via `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`. An abort is not
// a backend error: the spawn is killed and the caller reports a bare
// timeout, so this adapter never gets to degrade.
//
// A deadline at or above the host's budget therefore converts every slow
// backend into a hard failure — the exact outcome the degradation path
// exists to avoid. Measured healthy latency is 5-7s, so 20s leaves ~4x
// headroom for the read itself plus the public-HTTP fallback, while
// still finishing inside a default 30s host budget.
//
// Operators who raise `fetchTimeoutMs` on the host may raise this too;
// the configurable ceiling stays high for that case, but the DEFAULT
// must fit the default host budget.
export const DEFAULT_TIMEOUT_MS = 20_000
export const MIN_TIMEOUT_MS = 5_000
export const MAX_TIMEOUT_MS = 600_000
const VERSION_PROBE_TIMEOUT_MS = 4_000

/**
 * Environment variables that can redirect opencli's transport. We strip
 * them so a URL (or an unrelated shell export) can never re-point the
 * browser backend at a different CDP endpoint.
 */
const BLOCKED_ENV_KEYS = Object.freeze([
  'OPENCLI_CDP_ENDPOINT',
  'OPENCLI_BROWSER_WS',
])

// ── Failure taxonomy ─────────────────────────────────────────────────

/**
 * Reasons for which falling back to the public HTTP path is correct.
 * Anything not listed here propagates as an error.
 */
const DEGRADABLE = Object.freeze(new Set([
  'BINARY_MISSING',
  'BACKEND_UNAVAILABLE',
  'NOT_AUTHENTICATED',
  'BACKEND_TIMEOUT',
  'OUTPUT_TRUNCATED',
  'OUTPUT_INVALID',
]))

// ── Pure parsing ─────────────────────────────────────────────────────

/**
 * The single parser behind canHandle() and fetch().
 *
 * @param {string} urlString
 * @returns {{ kind: 'timeline', username: string, canonicalUrl: string } | null}
 */
export function parseTarget(urlString) {
  if (typeof urlString !== 'string' || urlString.length === 0) return null
  if (urlString.length > MAX_URL_LENGTH) return null
  let u
  try { u = new URL(urlString) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  // Credentials in the URL are never acceptable, and a non-default port
  // is not part of any X route.
  if (u.username || u.password) return null
  if (u.port) return null
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null

  // Percent-encoding is NOT decoded here on purpose: the username regex
  // rejects '%', so no double-decode is possible.
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length !== 1) return null

  let raw = parts[0]
  if (raw.startsWith('@')) raw = raw.slice(1)
  if (!USERNAME_RE.test(raw)) return null
  if (RESERVED_SEGMENTS.has(raw.toLowerCase())) return null

  return {
    kind: 'timeline',
    username: raw,
    canonicalUrl: `https://${CANONICAL_HOST}/${raw}`,
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  return parseTarget(url) !== null
}

/**
 * @param {any} _ctx
 */
export const capabilities = makeCapabilities({ tier, backends, cheap })

// ── Argument construction ────────────────────────────────────────────

/**
 * Build the exact argv for a timeline read.
 *
 * Everything except `target.username` is a literal. `limit` is a bounded
 * integer produced by this module — never read from the URL.
 *
 * @param {{ username: string }} target
 * @param {number} limit
 * @returns {string[]}
 */
export function buildArgv(target, limit) {
  return [
    'opencli', 'twitter', TIMELINE_VERB, target.username,
    '--limit', String(limit),
    '-f', 'json',
    '--site-session', 'ephemeral',
    '--keep-tab', 'false',
    '--window', 'background',
  ]
}

// ── Fetch ────────────────────────────────────────────────────────────

/**
 * @param {{ url: string, mode?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {any} ctx  adapter context: { policy, settings, ctx?, publicFetch? }
 */
export async function fetch(request, signal, ctx) {
  const url = request && request.url
  if (typeof url !== 'string' || url.length === 0) {
    throw toolError('x', 'INVALID_INPUT', 'x adapter requires { url: string }', 'internal')
  }
  const target = parseTarget(url)
  if (!target) {
    throw toolError('x', 'INVALID_URL', `x adapter refuses this URL shape: ${url}`,
      'phase A accepts only https://x.com/<username> profile URLs')
  }

  // Both the request URL and the URL opencli actually visits must pass
  // the policy. Validating only the former is a bypass: twitter.com can
  // be allowed while x.com is denied, and opencli navigates to x.com.
  if (ctx && ctx.policy) {
    await validateRemoteUrl(url, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
    await validateRemoteUrl(target.canonicalUrl, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
  }

  if (signal && signal.aborted) {
    throw abortError()
  }

  const slot = (ctx && ctx.settings && ctx.settings.adapters && ctx.settings.adapters.x) || {}
  const limit = clampInt(slot.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const timeoutMs = clampInt(slot.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const argv = buildArgv(target, limit)
  const provenance = await checkProvenance()

  // One browser fetch at a time. The bridge drives a single real browser;
  // concurrent leases would contend for the same tab and make both slow.
  const outcome = await serialized(() => runOnce(argv, timeoutMs, signal, ctx))

  if (!outcome.ok) {
    if (!DEGRADABLE.has(outcome.reason)) {
      throw outcome.error
    }
    return degrade(outcome.reason, outcome.detail, request, signal, ctx, outcome.error)
  }

  const tweets = outcome.tweets
  const body = renderTimeline(target, tweets, limit, provenance)

  return {
    url,
    statusCode: 200,
    body: { kind: 'html', content: body, extraction: 'x' },
    contentType: 'text/markdown',
    adapterId: id,
    truncated: false,
    // The browser session is authenticated by definition — opencli
    // reads through the user's logged-in browser. Marking this lets
    // source_check scope the evidence cache to the writing session
    // instead of publishing it profile-wide.
    authenticated: true,
    notes: provenanceNote(provenance),
    contentDigest: createHash('sha256').update(body).digest('hex'),
  }
}

/**
 * @returns {Promise<{ ok: true, tweets: any[] } | { ok: false, reason: string, detail: string, error: Error }>}
 */
async function runOnce(argv, timeoutMs, signal, ctx) {
  let res
  try {
    res = await runSubprocess(undefined, {
      argv,
      timeoutMs,
      env: controlledEnv(timeoutMs),
      signal,
    })
  } catch (e) {
    const cls = classifyError(e)
    if (cls === 'aborted' || (signal && signal.aborted)) {
      return fail('ABORTED', 'aborted by caller', withClass(e, 'aborted'))
    }
    const code = e && e.code
    if (code === 'ENOENT') {
      // Surface a CLASSIFIED error, not the raw spawn error: callers and
      // the degradation path both need a web_fetch-shaped failure with a
      // usable code and advice.
      return fail('BINARY_MISSING', 'the opencli executable is not on PATH',
        backendError('the opencli executable is not on PATH'))
    }
    if (code === 'SECURITY' || code === 'INVALID_INPUT') {
      return fail('INVALID_INPUT', String(e && e.message).slice(0, 300), e)
    }
    return fail('BACKEND_UNAVAILABLE', String((e && e.message) || e).slice(0, 300), withClass(e, cls))
  }

  if (!res || typeof res !== 'object') {
    return fail('OUTPUT_INVALID', 'subprocess returned no result envelope', backendError('no result envelope'))
  }

  // runSubprocess RESOLVES on timeout with exitCode null + truncated, so
  // "no throw" is not success. Classify explicitly.
  if (res.exitCode === null) {
    if (signal && signal.aborted) return fail('ABORTED', 'aborted by caller', abortError())
    return fail('BACKEND_TIMEOUT', `opencli did not finish within ${timeoutMs}ms`, backendError('timeout'))
  }
  if (res.exitCode !== 0) {
    const detail = firstLines(res.stderr || res.stdout, 400)
    const lower = detail.toLowerCase()
    if (lower.includes('not logged in') || lower.includes('login required') ||
        lower.includes('unauthorized') || lower.includes('auth')) {
      return fail('NOT_AUTHENTICATED', detail, backendError('not authenticated'))
    }
    return fail('BACKEND_UNAVAILABLE', `opencli exited ${res.exitCode}: ${detail}`, backendError('exit ' + res.exitCode))
  }
  if (res.truncated === true) {
    return fail('OUTPUT_TRUNCATED', 'opencli output exceeded the subprocess buffer', backendError('truncated'))
  }

  const parsed = parseTweetRows(res.stdout)
  if (!parsed.ok) {
    return fail(parsed.reason, parsed.detail, backendError(parsed.detail))
  }
  return { ok: true, tweets: parsed.rows }
}

function fail(reason, detail, error) {
  return { ok: false, reason, detail: String(detail || '').slice(0, 400), error }
}

/**
 * Parse opencli's stdout tolerantly, but never turn a broken payload into
 * a successful EMPTY list. An empty array is a legitimate result; empty
 * stdout, truncated JSON or a non-array envelope is a failure.
 *
 * @param {string} stdout
 */
export function parseTweetRows(stdout) {
  const raw = typeof stdout === 'string' ? stdout.trim() : ''
  if (raw.length === 0) {
    return { ok: false, reason: 'OUTPUT_INVALID', detail: 'opencli produced no stdout' }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'OUTPUT_INVALID', detail: `stdout is not JSON: ${raw.slice(0, 200)}` }
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
    return { ok: false, reason: 'BACKEND_UNAVAILABLE', detail: `opencli reported failure: ${JSON.stringify(data.error || {}).slice(0, 200)}` }
  }
  const rows = pickRows(data)
  if (!rows) {
    return { ok: false, reason: 'OUTPUT_INVALID', detail: `unrecognised payload shape: ${JSON.stringify(data).slice(0, 200)}` }
  }
  if (rows.length === 0) return { ok: true, rows: [] }

  const usable = rows.filter((r) => r && typeof r === 'object' &&
    (typeof r.id === 'string' || typeof r.id === 'number' || typeof r.text === 'string'))
  if (usable.length === 0) {
    return { ok: false, reason: 'OUTPUT_INVALID', detail: `${rows.length} rows, none with an id or text` }
  }
  return { ok: true, rows: usable }
}

function pickRows(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return null
  for (const key of ['data', 'tweets', 'results', 'items']) {
    if (Array.isArray(data[key])) return data[key]
  }
  return null
}

// ── Rendering ────────────────────────────────────────────────────────

function renderTimeline(target, tweets, limit, provenance) {
  const lines = []
  lines.push(`# @${target.username} — recent posts`)
  lines.push('')
  lines.push(`Source: https://x.com/${target.username}`)
  lines.push(`Retrieved: ${tweets.length} post(s), newest first, pinned excluded.`)
  lines.push('')
  for (const t of tweets) {
    const tid = t.id === undefined || t.id === null ? '' : String(t.id)
    const url = typeof t.url === 'string' && t.url.length > 0
      ? t.url
      : (tid ? `https://x.com/${target.username}/status/${tid}` : '')
    lines.push(`## ${url || (tid ? `post ${tid}` : 'post')}`)
    if (typeof t.created_at === 'string' && t.created_at.length > 0) lines.push(`- Date: ${t.created_at}`)
    const stats = []
    for (const [label, key] of [['Likes', 'likes'], ['Retweets', 'retweets'], ['Replies', 'replies'], ['Views', 'views']]) {
      if (t[key] !== undefined && t[key] !== null) stats.push(`${label}: ${t[key]}`)
    }
    if (stats.length > 0) lines.push(`- ${stats.join(' · ')}`)
    if (t.has_media === true) lines.push('- Has media: yes')
    if (typeof t.text === 'string' && t.text.length > 0) {
      lines.push('')
      lines.push(t.text)
    }
    lines.push('')
  }
  if (tweets.length >= limit) {
    lines.push(`_Output limited to ${limit} posts by configuration; this is NOT the full history._`)
    lines.push('')
  }
  lines.push(`_Backend: opencli${provenance.version ? ' ' + provenance.version : ''} via the OpenCLI browser bridge._`)
  return lines.join('\n').trim() + '\n'
}

// ── Degradation ──────────────────────────────────────────────────────

/**
 * Fall back to the public HTTP path — but ONLY through the callback the
 * fetch chain supplies, so the HTTP transport and content-type dispatch
 * stay owned by chained-fetch (no x.js → chainedFetch → x.js recursion),
 * and only for reasons on the allowlist.
 */
async function degrade(reason, detail, request, signal, ctx, originalError) {
  if (!ctx || typeof ctx.publicFetch !== 'function') {
    throw originalError
  }
  if (signal && signal.aborted) {
    throw abortError()
  }
  let res
  try {
    res = await ctx.publicFetch()
  } catch {
    // The public path failed too. Report the ORIGINAL backend failure;
    // do not mask it behind an unrelated HTTP error.
    throw originalError
  }
  return withDegradationNotice(res, reason, detail, 'x')
}

/**
 * Make the degradation visible in the BODY, not just in metadata. Callers
 * that only render `body.content` must still learn that the timeline was
 * not retrieved — returning a public profile shell as if it were the
 * timeline is worse than failing.
 *
 * Exported for tests.
 *
 * @param {any} res
 * @param {string} reason
 * @param {string} detail
 * @param {string} adapterId
 */
export function withDegradationNotice(res, reason, detail, adapterId) {
  const notice = [
    `> **Timeline not retrieved.** The ${adapterId} backend was unavailable (${reason}).`,
    `> What follows is the public HTTP page only — it does NOT contain the post list.`,
    detail ? `> Backend detail: ${detail}` : '',
    '',
  ].filter(Boolean).join('\n')

  const out = res && typeof res === 'object' ? { ...res } : {}
  const body = out.body && typeof out.body === 'object' ? { ...out.body } : { kind: 'text', content: '' }
  const content = typeof body.content === 'string' ? body.content : ''
  body.content = notice + content
  out.body = body
  out.adapterId = `${adapterId}-degraded`
  out.authenticated = false
  out.degraded = true
  out.degradationReason = reason
  out.notes = `x adapter degraded to the public HTTP path: ${reason}${detail ? ' — ' + detail : ''}`
  out.contentDigest = createHash('sha256').update(body.content).digest('hex')
  return out
}

// ── Provenance ───────────────────────────────────────────────────────

let provenancePromise = null

/**
 * Record what will actually execute: the resolved opencli version and
 * whether a user adapter is overriding the built-in twitter commands.
 * This is evidence, not a guarantee — see the security note at the top.
 */
export function checkProvenance() {
  if (!provenancePromise) provenancePromise = probeProvenance()
  return provenancePromise
}

/** Test hook. */
export function resetProvenanceCache() {
  provenancePromise = null
}

async function probeProvenance() {
  const out = { version: null, overridePresent: false, overrideDir: null }
  try {
    const res = await runSubprocess(undefined, {
      argv: ['opencli', '--version'],
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    })
    if (res && res.exitCode === 0 && typeof res.stdout === 'string') {
      const m = res.stdout.match(/\d+\.\d+\.\d+/)
      if (m) out.version = m[0]
    }
  } catch { /* absent binary is classified later, by the real command */ }

  try {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const dir = `${os.homedir()}/.opencli/clis`
    if (fs.existsSync(dir)) {
      out.overrideDir = dir
      out.overridePresent = fs.readdirSync(dir).length > 0
    }
  } catch { /* ignore */ }

  return out
}

function provenanceNote(p) {
  const bits = [`opencli ${p.version || 'version unknown'}`, 'site-session=ephemeral', 'keep-tab=false']
  if (p.overridePresent) bits.push(`user adapter override present in ${p.overrideDir}`)
  return bits.join('; ')
}

// ── Helpers ──────────────────────────────────────────────────────────

function controlledEnv(timeoutMs) {
  // Start from the real environment: the subprocess wrapper passes
  // spec.env straight through to spawn and does not re-add PATH.
  const env = { ...process.env }
  for (const k of BLOCKED_ENV_KEYS) delete env[k]
  // Seconds, per opencli's contract. This is our own extra layer, not a
  // cancellation guarantee — the outer subprocess timeout is the backstop.
  env.OPENCLI_BROWSER_COMMAND_TIMEOUT = String(Math.max(1, Math.floor(timeoutMs / 1000)))
  return env
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function firstLines(text, cap) {
  return String(text || '').split('\n').slice(0, 6).join(' ').trim().slice(0, cap)
}

function backendError(detail) {
  return toolError('x', 'WEB_FETCH_FAILED', `opencli backend failed: ${detail}`,
    'the x adapter needs a working OpenCLI bridge (opencli on PATH, daemon running, browser logged into x.com); run web_doctor')
}

function abortError() {
  const e = new Error('[web_fetch] aborted by caller | CODE: ABORTED')
  e.name = 'AbortError'
  e.code = 'ABORTED'
  e.class = 'aborted'
  return e
}

// One browser fetch at a time — the bridge holds a single real browser.
let chain = Promise.resolve()
function serialized(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

/** Test hook: reset the serialisation chain. */
export function resetSerialization() {
  chain = Promise.resolve()
}
