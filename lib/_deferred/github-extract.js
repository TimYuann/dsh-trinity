// lib/tools/github-extract.js — GitHub repo extraction (DESIGN §1.20)
//
// Path-traversal safe (realpath containment), external git/gh binary with
// `--depth 1 --single-branch`. isAvailable() checks git OR gh.

import { defineTool } from '../schema/define-tool.js'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { toolError, httpStatusToCode } from '../errors.js'

export const TOOL_NAME = 'github_extract'

export const PARAMETERS = {
  url: { type: 'string', required: true, description: 'GitHub URL (github.com/<owner>/<repo> or /tree/<ref>/<path> or /blob/<ref>/<path>)' },
  forceClone: { type: 'boolean', default: false, description: 'Skip size check; always clone' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', required: true },
      title: { type: 'string', required: true, description: '"<owner>/<repo> - <path>" or "<owner>/<repo>"' },
      content: { type: 'string', required: true, description: 'tree | dir listing | file content | README' },
      error: { type: 'string' },
      clonedTo: { type: 'string', description: 'Local clone path (when full clone succeeded)' },
    },
  },
  render(_args, value) {
    if (!value) return [{ type: 'text', text: '(no GitHub content)' }]
    return [{ type: 'text', text: `# ${value.title}\n${value.url}\n\n${value.content}` }]
  },
}

const NOISE_DIRS = new Set(['node_modules', 'vendor', '.next', 'dist', 'build', '.venv', '__pycache__', 'target', '.git', '.cache'])
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pdf'])

export function which(bin) {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim().length > 0
  } catch {
    return false
  }
}

export function isAvailable() {
  return which('git') || which('gh')
}

function parseGitHubUrl(url) {
  let u
  try { u = new URL(url) } catch {
    throw toolError(
      'github_extract',
      'INVALID_URL',
      'URL is malformed',
      'URL is malformed; expected a github.com URL like https://github.com/owner/repo',
    )
  }
  if (u.hostname !== 'github.com') {
    throw toolError(
      'github_extract',
      'INVALID_INPUT',
      `only github.com URLs are supported (got hostname: ${u.hostname})`,
      'only github.com URLs are supported; for other git hosts, use a different tool or run git/gh manually via bash',
    )
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) {
    throw toolError(
      'github_extract',
      'TOO_FEW',
      `URL must include owner and repo (e.g. https://github.com/facebook/react); got: ${url}`,
      'URL must include owner and repo (e.g. https://github.com/facebook/react); got: <url>',
    )
  }
  const owner = parts[0]
  const repo = parts[1]
  let ref = null
  let refIsFullSha = false
  let subPath = ''
  let type = 'root'
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    type = parts[2]
    ref = parts[3]
    refIsFullSha = /^[0-9a-f]{7,40}$/i.test(ref)
    subPath = parts.slice(4).join('/')
  }
  return { owner, repo, ref, refIsFullSha, path: subPath, type }
}

async function fetchViaApi({ owner, repo, ref, subPath }, signal) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${subPath}${ref ? '?ref=' + ref : ''}`
  const response = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'dsh-trinity' }, signal })
  if (!response.ok) {
    const { code, label } = httpStatusToCode(response.status)
    throw toolError('github_extract', code, `GitHub API returned HTTP ${response.status} (${label})`, `GitHub API returned HTTP ${response.status}; check the repo is public (or you have access) and the rate limit hasn't been hit`)
  }
  const data = await response.json()
  if (Array.isArray(data)) {
    return data.map((it) => `${it.type === 'dir' ? '📁' : '📄'} ${it.name}`).join('\n')
  }
  if (data && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8')
  }
  return '(empty)'
}

async function cloneRepo({ owner, repo, ref }, config, signal) {
  const clonePath = (config && config.githubClone && config.githubClone.clonePath) || '/tmp/dsh-github-repos'
  try { mkdirSync(clonePath, { recursive: true }) } catch { /* ignore */ }
  const target = path.join(clonePath, `${owner}-${repo}-${(ref || 'HEAD').replace(/[^a-zA-Z0-9_.-]/g, '_')}`)
  try { mkdirSync(target, { recursive: true }) } catch { /* ignore */ }
  const args = ['clone', '--depth', '1', '--single-branch']
  if (ref) { args.push('--branch', ref) }
  args.push(`https://github.com/${owner}/${repo}.git`, target)
  const bin = which('gh') ? 'gh' : 'git'
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1' }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, signal })
    let stderr = ''
    proc.stderr.on('data', (c) => { stderr += c.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(target)
      else reject(new Error(`${bin} exit ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

function listTree(rootDir, subPath, maxEntries = 200) {
  const root = realpathSync(rootDir)
  const base = subPath ? path.join(root, subPath) : root
  const realBase = realpathSync(base)
  if (!realBase.startsWith(root + '/') && realBase !== root) {
    throw toolError(
      'github_extract',
      'PATH_TRAVERSAL',
      `path goes outside the repo root (.. segments detected); base=${realBase}`,
      "path goes outside the repo root (.. segments detected); only paths inside the target repo are allowed",
    )
  }
  const entries = []
  function walk(dir, depth) {
    if (entries.length >= maxEntries || depth > 5) return
    for (const item of readdirSync(dir)) {
      if (entries.length >= maxEntries) return
      if (NOISE_DIRS.has(item)) continue
      const full = path.join(dir, item)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile()) {
        if (item.includes('.') && BINARY_EXTS.has(item.slice(item.lastIndexOf('.')).toLowerCase())) continue
        const rel = path.relative(root, full)
        entries.push(rel)
      }
    }
  }
  walk(realBase, 0)
  return entries
}

export function createTool(opts = {}) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Extract a GitHub URL (repo root / tree / blob) via git/gh clone + local listing. Zero npm deps.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) throw new Error('Aborted')
      const url = args && typeof args.url === 'string' ? args.url : ''
      const info = parseGitHubUrl(url)
      const ctx = opts && opts.ctx ? opts.ctx : null
      if (!ctx) {
        throw toolError(
          'github_extract',
          'MISSING_CTX',
          'internal plugin bug — chained ctx is unavailable',
          'internal plugin bug — file an issue with DSH Trinity',
        )
      }
      const cfg = (ctx.config && ctx.config.githubClone) || { enabled: true, clonePath: '/tmp/dsh-github-repos' }

      // SHA → API path
      if (info.refIsFullSha) {
        try {
          const content = await fetchViaApi({ owner: info.owner, repo: info.repo, ref: info.ref, subPath: info.path }, exec && exec.signal)
          return { url, title: `${info.owner}/${info.repo} - ${info.path || ''}`.replace(/ - $/, ''), content, error: null }
        } catch (e) {
          throw toolError(
            'github_extract',
            'PROVIDER_ERROR',
            `GitHub API extraction failed: ${e.message || String(e)}`,
            `GitHub API extraction failed; check the repo is public (or you have access), the ref is a valid SHA, and the rate limit hasn't been hit`,
            { cause: e },
          )
        }
      }

      // Non-SHA → clone + local listing
      try {
        const target = await cloneRepo({ owner: info.owner, repo: info.repo, ref: info.ref }, { githubClone: cfg }, exec && exec.signal)
        let content = ''
        if (info.type === 'blob' && info.path) {
          const real = realpathSync(path.join(target, info.path))
          if (!real.startsWith(target)) {
            throw toolError(
              'github_extract',
              'PATH_TRAVERSAL',
              `path goes outside the repo root (.. segments detected); real=${real}`,
              "path goes outside the repo root (.. segments detected); only paths inside the target repo are allowed",
            )
          }
          const buf = readFileSync(real)
          content = buf.length > 100 * 1024 ? buf.toString('utf8', 0, 100 * 1024) + '\n\n[truncated at 100K chars]' : buf.toString('utf8')
        } else {
          const tree = listTree(target, info.path)
          content = tree.length > 0 ? tree.join('\n') : '(empty tree)'
        }
        return { url, title: `${info.owner}/${info.repo}${info.path ? ' - ' + info.path : ''}`, content, error: null, clonedTo: target }
      } catch (e) {
        // API fallback
        try {
          const content = await fetchViaApi({ owner: info.owner, repo: info.repo, ref: info.ref, subPath: info.path }, exec && exec.signal)
          return { url, title: `${info.owner}/${info.repo}${info.path ? ' - ' + info.path : ''}`, content, error: 'clone failed: ' + e.message + ' — using API fallback' }
        } catch (e2) {
          throw toolError(
            'github_extract',
            'PROVIDER_ERROR',
            `GitHub extraction failed: ${e2.message || e.message || 'unknown'}`,
            `GitHub extraction failed (both clone and API paths); check the repo URL is valid, the ref exists, and you have network access to github.com`,
            { cause: e2 },
          )
        }
      }
    },
  })
}