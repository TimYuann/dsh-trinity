// lib/adapters/github.js — Cheap GitHub ContentAdapter (SPEC §II.6).
//
// Cheap default behaviour:
//   - README via `gh api repos/{owner}/{repo}/readme` (markdown body)
//   - Tree summary via `gh api repos/{owner}/{repo}/git/trees/<sha>?recursive=1`
//     (truncated to TOP_LEVEL_PATHS_MAX paths)
//   - PR / Issue summary via `gh api repos/{owner}/{repo}/pulls/<n>` or
//     `gh api repos/{owner}/{repo}/issues/<n>` (when the URL targets one)
//
// Heavy behaviour (full clone, review threads, comment threads) is
// reserved for the gated `github_pr_issue` Tool and is NOT here.
//
// Per SPEC §II.7:
//   - Only `github.com` / `*.github.com` hosts accepted.
//   - Secondary requests use argv arrays, not shell strings (via
//     `lib/util/subprocess.js`).
//   - No LLM call, no Tool invocation.

import { createHash } from 'node:crypto'
import { runSubprocess } from '../util/subprocess.js'
import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { classifyError, withClass } from '../classify-error.js'
import { toolError } from '../errors.js'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'github'
export const tier = 0
export const cheap = true
export const backends = ['gh']

const TOP_LEVEL_PATHS_MAX = 50
const BODY_CAP = 8_000 // markdown body cap per section

const GH_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  if (!GH_HOSTS.has(u.hostname.toLowerCase())) return false
  const parts = u.pathname.split('/').filter(Boolean)
  return parts.length >= 2
}

/**
 * @param {any} _ctx
 */
export const capabilities = makeCapabilities({ tier, backends, cheap })

/**
 * @param {{ url: string, mode?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {{ policy?: { ssrf?: any, domainPolicy?: any }, tools?: any }} ctx
 */
export async function fetch(request, signal, ctx) {
  const url = request && request.url
  if (typeof url !== 'string' || url.length === 0) {
    throw toolError('github', 'INVALID_INPUT', 'github adapter requires { url: string }', 'internal')
  }
  let u
  try { u = new URL(url) } catch {
    throw toolError('github', 'INVALID_URL', `cannot parse URL: ${url}`, 'pass a github.com URL')
  }
  if (!GH_HOSTS.has(u.hostname.toLowerCase())) {
    throw toolError('github', 'SECURITY',
      `github adapter refuses non-github.com host: ${u.hostname}`,
      'SPEC §II.7: GitHub Adapter accepts only github.com / *.github.com hosts')
  }

  // 1. validateUrl — required even though canHandle was pre-validated
  if (ctx && ctx.policy) {
    await validateRemoteUrl(url, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
  }

  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw toolError('github', 'INVALID_URL', `github URL must include owner/repo: ${url}`, 'pass a github.com/{owner}/{repo} or .../pull/{n} URL')
  }
  const owner = parts[0]
  const repo = parts[1]
  const tail = parts.slice(2)

  // Cheap variant: do the work in parallel. Each gh call has its own timeout
  // and argv array; we collect partial results.
  // R3 P3 #26: the tree endpoint is capped by --jq '.tree[].path' +
  // client-side truncation to TOP_LEVEL_PATHS_MAX. Recursive trees on
  // monorepos can exceed BODY_CAP; we never let them through.
  const tasks = []
  tasks.push({ kind: 'readme', fn: () => runGh(['api', `repos/${owner}/${repo}/readme`, '--jq', '.content'], signal) })
  tasks.push({ kind: 'tree', fn: () => runGh(['api', `repos/${owner}/${repo}/git/trees/HEAD`, '--jq', '.tree[].path'], signal) })
  let prNumber = null
  let issueNumber = null
  if (tail.length >= 2 && (tail[0] === 'pull' || tail[0] === 'issues')) {
    const n = Number(tail[1])
    if (Number.isInteger(n) && n > 0) {
      if (tail[0] === 'pull') prNumber = n
      else issueNumber = n
      tasks.push({
        kind: tail[0] === 'pull' ? 'pr' : 'issue',
        fn: () => runGh(['api', tail[0] === 'pull'
          ? `repos/${owner}/${repo}/pulls/${n}`
          : `repos/${owner}/${repo}/issues/${n}`], signal),
      })
    }
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.fn()))

  const lines = []
  lines.push(`# ${owner}/${repo}`)
  lines.push('')
  lines.push(`Source: ${url}`)
  lines.push('')
  if (prNumber) {
    const r = settled[2]
    if (r.status === 'fulfilled' && r.value.exitCode === 0) {
      try {
        const j = JSON.parse(r.value.stdout || 'null')
        if (j) {
          lines.push(`## Pull Request #${prNumber}: ${j.title || ''}`)
          lines.push('')
          if (j.state) lines.push(`- State: ${j.state}`)
          if (j.user && j.user.login) lines.push(`- Author: @${j.user.login}`)
          if (j.base && j.base.ref) lines.push(`- Base: ${j.base.ref}`)
          if (j.head && j.head.ref) lines.push(`- Head: ${j.head.ref}`)
          if (typeof j.body === 'string' && j.body.length > 0) {
            lines.push('')
            lines.push(j.body.slice(0, BODY_CAP))
          }
        }
      } catch (e) { /* ignore */ }
    }
  } else if (issueNumber) {
    const r = settled[2]
    if (r.status === 'fulfilled' && r.value.exitCode === 0) {
      try {
        const j = JSON.parse(r.value.stdout || 'null')
        if (j) {
          lines.push(`## Issue #${issueNumber}: ${j.title || ''}`)
          lines.push('')
          if (j.state) lines.push(`- State: ${j.state}`)
          if (j.user && j.user.login) lines.push(`- Author: @${j.user.login}`)
          if (Array.isArray(j.labels) && j.labels.length > 0) {
            lines.push(`- Labels: ${j.labels.map((l) => l.name).join(', ')}`)
          }
          if (typeof j.body === 'string' && j.body.length > 0) {
            lines.push('')
            lines.push(j.body.slice(0, BODY_CAP))
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  // README
  {
    const r = settled[0]
    if (r.status === 'fulfilled' && r.value.exitCode === 0) {
      try {
        const j = JSON.parse(r.value.stdout || 'null')
        if (j && typeof j.content === 'string') {
          const decoded = Buffer.from(j.content, 'base64').toString('utf8')
          if (decoded.length > 0) {
            lines.push('## README')
            lines.push('')
            lines.push(decoded.slice(0, BODY_CAP))
            lines.push('')
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  // Tree summary
  {
    const r = settled[1]
    if (r.status === 'fulfilled' && r.value.exitCode === 0) {
      try {
        // R3 P3 #26: with --jq '.tree[].path' the response is a JSON
        // array of strings (NOT the {tree:[,path,type]} envelope). Fall
        // back to envelope parsing for backward compat with `gh api
        // .../tree` responses that bypass --jq.
        const raw = r.value.stdout || ''
        let paths = []
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            paths = parsed.filter((p) => typeof p === 'string')
          } else if (parsed && Array.isArray(parsed.tree)) {
            paths = parsed.tree.map((p) => (p && typeof p.path === 'string') ? `${p.path}${p.type === 'tree' ? '/' : ''}` : '').filter(Boolean)
          }
        } catch { /* fall through */ }
        if (paths.length > 0) {
          const top = paths
            .filter((p) => !p.includes('/'))
            .slice(0, TOP_LEVEL_PATHS_MAX)
          if (top.length > 0) {
            lines.push(`## Tree (top-level, ${top.length} paths)`)
            lines.push('')
            lines.push(...top.map((p) => `- ${p}`))
            lines.push('')
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  const body = lines.join('\n').trim() + '\n'
  return {
    url,
    statusCode: 200,
    body: { kind: 'html', content: body, extraction: 'github' },
    contentType: 'text/markdown',
    adapterId: id,
    truncated: body.length >= BODY_CAP,
    contentDigest: createHash('sha256').update(body).digest('hex'),
  }
}

/**
 * @param {string[]} argv
 * @param {AbortSignal | undefined} signal
 */
async function runGh(argv, signal) {
  try {
    return await runSubprocess(undefined, { argv, timeoutMs: 8000, signal })
  } catch (e) {
    const cls = classifyError(e)
    throw withClass(e, cls)
  }
}
