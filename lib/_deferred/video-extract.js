// lib/tools/video-extract.js — local video extraction (DESIGN §1.19)

import { defineTool } from '../schema/define-tool.js'
import { realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { toolError } from '../errors.js'

export const TOOL_NAME = 'video_extract'

export const PARAMETERS = {
  filePath: { type: 'string', required: true, description: 'Absolute path to local video file' },
  prompt: { type: 'string' },
  model: { type: 'string' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', required: true },
      title: { type: 'string', required: true },
      content: { type: 'string', required: true },
      duration: { type: 'integer' },
      frames: { type: 'array', items: { type: 'object', properties: { timestamp: { type: 'string' }, data: { type: 'string' }, mimeType: { type: 'string' } } } },
      error: { type: 'string' },
    },
  },
  render(_args, value) {
    if (!value) return [{ type: 'text', text: '(no video extracted)' }]
    return [{ type: 'text', text: `# ${value.title}\n${value.url}\n\n${value.content}` }]
  },
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mpeg', '.wmv', '.flv', '.3gp'])

export function which(bin) {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim().length > 0
  } catch {
    return false
  }
}

export function isAvailable(creds) {
  if (!which('ffmpeg') || !which('ffprobe')) return false
  if (creds && creds.resolved && creds.resolved.gemini && creds.resolved.gemini.key) return true
  if (creds && creds.resolved && creds.resolved.perplexity && creds.resolved.perplexity.key) return true
  return false
}

function allowedRoots(creds) {
  const arr = (creds && creds.video && Array.isArray(creds.video.allowedRoots)) ? creds.video.allowedRoots : []
  return arr.map((p) => {
    if (p === '$HOME') return os.homedir()
    return p
  })
}

function withinAllowedRoots(real, allowed) {
  for (const root of allowed) {
    if (real === root || real.startsWith(root + '/')) return true
  }
  return false
}

export function createTool(opts = {}) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Extract a local video file via Gemini multimodal understanding. Requires ffmpeg + Gemini key.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      const filePath = args && typeof args.filePath === 'string' ? args.filePath : ''
      if (!filePath) {
        throw toolError(
          'video_extract',
          'TOO_FEW',
          "the 'filePath' field is required (local video file path)",
          "the 'filePath' field is required (local video file path); pass filePath=\"/abs/path/to/video.mp4\"",
        )
      }
      const ctx = opts && opts.ctx ? opts.ctx : null
      if (!ctx || !ctx.creds) {
        throw toolError(
          'video_extract',
          'MISSING_CTX',
          'internal plugin bug — chained ctx is unavailable',
          'internal plugin bug — file an issue with DSH Trinity',
        )
      }

      let real
      try { real = realpathSync(filePath) } catch {
        throw toolError(
          'video_extract',
          'FILE_RESOLVE_FAIL',
          'filePath does not exist or cannot resolve',
          'filePath does not exist or cannot resolve (e.g. contains a broken symlink); check the path',
        )
      }
      const base = pathBasename(real)
      if (base.startsWith('.')) {
        throw toolError(
          'video_extract',
          'HIDDEN_FILE',
          "path starts with '.' (hidden file)",
          "path starts with '.' (hidden file); use a non-hidden file path — video_extract rejects dotfiles for safety",
        )
      }
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : ''
      if (!VIDEO_EXTS.has(ext)) {
        throw toolError(
          'video_extract',
          'UNSUPPORTED_TYPE',
          `file extension is not a supported video format (${ext || 'none'})`,
          `file extension is not a supported video format; supported: .mp4 .mov .mkv .webm .avi — convert your file to one of these`,
        )
      }
      const allowed = allowedRoots(ctx.creds)
      if (!withinAllowedRoots(real, allowed)) {
        throw toolError(
          'video_extract',
          'PATH_NOT_ALLOWED',
          `filePath resolves outside video.allowedRoots (${real})`,
          `filePath resolves to a directory outside video.allowedRoots (default: $HOME, /tmp); add the parent directory to video.allowedRoots in web-search.json, or use a file inside an allowed root`,
        )
      }
      const stat = statSync(real)
      const maxSizeMB = (ctx.creds.video && ctx.creds.video.maxSizeMB) ? ctx.creds.video.maxSizeMB : 50
      if (stat.size > maxSizeMB * 1024 * 1024) {
        throw toolError(
          'video_extract',
          'TOO_LARGE',
          `file exceeds video maxSizeMB (${Math.round(stat.size / 1024 / 1024)}MB > ${maxSizeMB}MB)`,
          `file exceeds video.maxSizeMB cap (default 50MB); reduce the file or raise video.maxSizeMB in web-search.json`,
        )
      }
      // Try Gemini Files API upload (best-effort; falls back to web tool path
      // when key is missing). Without a real upload implementation we
      // surface a graceful unavailable.
      const geminiKey = ctx.creds.resolved && ctx.creds.resolved.gemini && ctx.creds.resolved.gemini.key
      if (!geminiKey) {
        return {
          url: real,
          title: base,
          content: 'video_extract: gemini key unavailable — cannot upload video (try gemini_web-equivalent route or supply GEMINI_API_KEY).',
          duration: null,
          error: 'GEMINI_API_KEY missing',
        }
      }
      return {
        url: real,
        title: base,
        content: 'video_extract: upload via Gemini Files API is not implemented in v1.0.0; please use gemini_url_context on a hosted video URL instead.',
        duration: null,
        error: 'NOT_IMPLEMENTED',
      }
    },
  })
}

function pathBasename(p) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}