// lib/tools/github-pr-issue.js — heavy GitHub PR/Issue Tool (SPEC §II.5).
//
// This Tool is the HEAVY variant — the cheap variant is the GitHub
// ContentAdapter (`lib/adapters/github.js`). Per SPEC §II.5, this
// Tool is gated by `web-access-chain.tools.githubPrIssue.enabled` and
// defaults to OFF. The Tool can:
//   - include review threads
//   - include PR/Issue comment threads
//   - include review state per file
//
// Subprocess: `gh api` with parameter arrays (SPEC §II.7).

import { defineTool } from '../schema/define-tool.js'
import { runSubprocess } from '../util/subprocess.js'
import { toolError } from '../errors.js'

export const TOOL_NAME = 'github_pr_issue'

export const PARAMETERS = {
  url: { type: 'string', required: true, description: 'GitHub PR / Issue URL (e.g. https://github.com/owner/repo/pull/123)' },
  includeComments: { type: 'boolean', default: true, description: 'Include comment threads' },
  includeReviewThreads: { type: 'boolean', default: false, description: 'Include review threads (PR only, more network calls)' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string' },
      kind: { type: 'string' },
      title: { type: 'string' },
      state: { type: 'string' },
      author: { type: 'string' },
      body: { type: 'string' },
      comments: { type: 'array' },
      reviewThreads: { type: 'array' },
    },
  },
  render(_args, value) {
    if (!value || typeof value !== 'object') return []
    const blocks = []
    blocks.push({ type: 'text', text: `# ${value.title || value.kind || value.url}` })
    if (value.state) blocks.push({ type: 'text', text: `State: ${value.state}` })
    if (value.author) blocks.push({ type: 'text', text: `Author: @${value.author}` })
    if (typeof value.body === 'string' && value.body.length > 0) {
      blocks.push({ type: 'text', text: `\n${value.body.slice(0, 20_000)}` })
    }
    if (Array.isArray(value.comments) && value.comments.length > 0) {
      blocks.push({ type: 'text', text: `\n## Comments (${value.comments.length})` })
      for (const c of value.comments.slice(0, 50)) {
        blocks.push({ type: 'text', text: `- @${c.author || '?'} (${c.created_at || '?'}): ${(c.body || '').slice(0, 400)}` })
      }
    }
    if (Array.isArray(value.reviewThreads) && value.reviewThreads.length > 0) {
      blocks.push({ type: 'text', text: `\n## Review threads (${value.reviewThreads.length})` })
      for (const t of value.reviewThreads.slice(0, 20)) {
        blocks.push({ type: 'text', text: `- ${t.path || '?'}: ${(t.body || '').slice(0, 200)}` })
      }
    }
    return blocks
  },
}

const GH_HOST_RE = /^https?:\/\/(www\.)?github\.com\//i

/**
 * @param {{ ctx: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Heavy GitHub PR / Issue extraction with comments and review threads. Gated by web-access-chain.tools.githubPrIssue.enabled.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) {
        const e = new Error('Aborted')
        e.name = 'AbortError'
        e.code = 'ABORTED'
        return Promise.reject(e)
      }
      if (!opts || !opts.ctx) {
        throw toolError(TOOL_NAME, 'MISSING_CTX', 'ctx unavailable', 'internal')
      }
      const settings = (opts && opts.settings) || {}
      const gate = (settings.tools && settings.tools.githubPrIssue) || {}
      if (gate.enabled !== true) {
        throw toolError(TOOL_NAME, 'CONFIG',
          'github_pr_issue is disabled',
          'set web-access-chain.tools.githubPrIssue.enabled: true in settings to use this Tool')
      }
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) {
        throw toolError(TOOL_NAME, 'INVALID_INPUT', 'url is required', 'pass a github.com PR/Issue URL')
      }
      if (!GH_HOST_RE.test(url)) {
        throw toolError(TOOL_NAME, 'INVALID_URL', `not a github.com URL: ${url}`, 'pass https://github.com/owner/repo/pull/{n} or .../issues/{n}')
      }
      const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/i)
      if (!m) {
        throw toolError(TOOL_NAME, 'INVALID_URL', `URL must be a PR or issue: ${url}`, 'pass https://github.com/owner/repo/pull/{n} or .../issues/{n}')
      }
      const owner = m[1]
      const repo = m[2]
      const kind = m[3]
      const n = m[4]
      const isPR = kind.toLowerCase() === 'pull'

      const TIMEOUT_MS = 15_000
      const tasks = []
      const endpoint = isPR ? `repos/${owner}/${repo}/pulls/${n}` : `repos/${owner}/${repo}/issues/${n}`
      tasks.push({ kind: 'main', fn: () => runGh(['api', endpoint], exec && exec.signal, TIMEOUT_MS) })

      let comments = []
      if (args.includeComments !== false) {
        const commentsEndpoint = `repos/${owner}/${repo}/issues/${n}/comments`
        tasks.push({ kind: 'comments', fn: () => runGh(['api', commentsEndpoint], exec && exec.signal, TIMEOUT_MS) })
      }

      let reviewThreads = []
      if (isPR && args.includeReviewThreads === true) {
        tasks.push({ kind: 'reviews', fn: () => runGh(['api', `repos/${owner}/${repo}/pulls/${n}/reviews`], exec && exec.signal, TIMEOUT_MS) })
        tasks.push({ kind: 'reviewComments', fn: () => runGh(['api', `repos/${owner}/${repo}/pulls/${n}/comments`], exec && exec.signal, TIMEOUT_MS) })
      }

      const settled = await Promise.allSettled(tasks.map((t) => t.fn()))
      const main = settled[0]
      if (main.status !== 'fulfilled' || main.value.exitCode !== 0) {
        const stderr = main.status === 'fulfilled' ? main.value.stderr : String(main.reason)
        throw toolError(TOOL_NAME, 'WEB_FETCH_FAILED', `gh api failed: ${stderr.slice(0, 200)}`, 'verify gh is authenticated (`gh auth status`)')
      }
      let mainJson
      try { mainJson = JSON.parse(main.value.stdout) } catch (e) {
        throw toolError(TOOL_NAME, 'INVALID_RESPONSE', `gh api returned non-JSON: ${e.message || e}`, 'check provider response')
      }

      if (args.includeComments !== false) {
        const r = settled[1]
        if (r.status === 'fulfilled' && r.value.exitCode === 0) {
          try {
            const arr = JSON.parse(r.value.stdout)
            if (Array.isArray(arr)) comments = arr.map((c) => ({
              author: c.user && c.user.login,
              body: c.body,
              created_at: c.created_at,
            }))
          } catch { /* ignore */ }
        }
      }

      if (isPR && args.includeReviewThreads === true) {
        const r2 = settled[2]
        const r3 = settled[3]
        const reviews = (r2 && r2.status === 'fulfilled' && r2.value.exitCode === 0) ? safeJson(r2.value.stdout) : []
        const reviewComments = (r3 && r3.status === 'fulfilled' && r3.value.exitCode === 0) ? safeJson(r3.value.stdout) : []
        const threads = {}
        for (const c of (reviewComments || [])) {
          const key = `${c.path || '?'}#${c.line || '?'}`
          if (!threads[key]) threads[key] = { path: c.path, body: c.body, line: c.line, state: null }
        }
        for (const r of (reviews || [])) {
          if (r.state) {
            for (const c of reviewComments || []) {
              const key = `${c.path || '?'}#${c.line || '?'}`
              if (threads[key]) threads[key].state = r.state
            }
          }
        }
        reviewThreads = Object.values(threads)
      }

      return {
        url,
        kind: isPR ? 'pr' : 'issue',
        title: mainJson.title,
        state: mainJson.state,
        author: mainJson.user && mainJson.user.login,
        body: mainJson.body || '',
        comments,
        reviewThreads,
      }
    },
  })
}

async function runGh(argv, signal, timeoutMs) {
  return runSubprocess(undefined, { argv, timeoutMs, signal })
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return [] }
}
