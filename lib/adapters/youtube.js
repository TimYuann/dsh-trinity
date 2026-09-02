// lib/adapters/youtube.js — Cheap YouTube ContentAdapter (SPEC §II.6).
//
// Cheap default behaviour:
//   - metadata via `yt-dlp --skip-download --dump-json <url>`
//   - transcript via `yt-dlp --write-sub --skip-download --sub-format
//     vtt/best --sub-langs en,en-US --convert-subs srt -o -` (we only
//     need the caption text, not the video file)
//
// Heavy behaviour (full video download, ffmpeg, Gemini multimodal) is
// reserved for the gated `video_extract` Tool and is NOT here.
//
// Per SPEC §II.7:
//   - Secondary requests use argv arrays (no shell strings).
//   - No LLM call, no Tool invocation.

import { createHash } from 'node:crypto'
import { runSubprocess } from '../util/subprocess.js'
import { validateRemoteUrl } from '../providers/fetch/url-policy.js'
import { classifyError, withClass } from '../classify-error.js'
import { toolError } from '../errors.js'
import { makeCapabilities } from '../util/capabilities.js'

export const id = 'youtube'
export const tier = 0
export const cheap = true
export const backends = ['yt-dlp']

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'youtu.be',
])

const BODY_CAP = 20_000

/**
 * @param {string} url
 * @returns {boolean}
 */
export function canHandle(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  return YT_HOSTS.has(u.hostname.toLowerCase())
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
    throw toolError('youtube', 'INVALID_INPUT', 'youtube adapter requires { url: string }', 'internal')
  }
  let u
  try { u = new URL(url) } catch {
    throw toolError('youtube', 'INVALID_URL', `cannot parse URL: ${url}`, 'pass a youtube.com or youtu.be URL')
  }
  if (!YT_HOSTS.has(u.hostname.toLowerCase())) {
    throw toolError('youtube', 'INVALID_URL',
      `youtube adapter refuses non-youtube host: ${u.hostname}`,
      'pass a youtube.com/watch?v=... or youtu.be/... URL')
  }

  // 1. validateUrl
  if (ctx && ctx.policy) {
    await validateRemoteUrl(url, { ssrf: ctx.policy.ssrf, domainPolicy: ctx.policy.domainPolicy })
  }

  // 2. Run yt-dlp in two passes: dump JSON for metadata, then write subs.
  // We use --skip-download + --write-sub (no --convert-subs because the
  // output goes to stdout via -o -; we want the raw vtt text).
  // R3 P2 #22: --write-sub matches SPEC §II.6 exactly (not --write-auto-sub,
  // which yields auto-generated captions whose quality is lower than
  // official subs).
  const metaArgv = [
    'yt-dlp', '--skip-download', '--no-warnings', '--no-progress',
    '--dump-single-json', url,
  ]
  const subArgv = [
    'yt-dlp', '--skip-download', '--no-warnings', '--no-progress',
    '--write-sub', '--sub-format', 'vtt/best', '--sub-langs', 'en,en-US,en.*',
    '-o', '-', url,
  ]
  const TIMEOUT_MS = 12_000

  const settled = await Promise.allSettled([
    runSubprocess(undefined, { argv: metaArgv, timeoutMs: TIMEOUT_MS, signal }),
    runSubprocess(undefined, { argv: subArgv, timeoutMs: TIMEOUT_MS, signal }),
  ])

  const lines = []
  lines.push(`# YouTube: ${url}`)
  lines.push('')

  if (settled[0].status === 'fulfilled') {
    const r = settled[0].value
    if (r && r.exitCode === 0 && r.stdout) {
      try {
        const j = JSON.parse(r.stdout)
        if (j) {
          if (j.title) { lines.push(`## ${j.title}`); lines.push('') }
          if (j.uploader) lines.push(`- Uploader: ${j.uploader}`)
          if (j.uploader_id) lines.push(`- Channel: @${j.uploader_id}`)
          if (typeof j.duration === 'number') {
            const s = Math.round(j.duration)
            const mm = String(Math.floor(s / 60)).padStart(2, '0')
            const ss = String(s % 60).padStart(2, '0')
            lines.push(`- Duration: ${mm}:${ss}`)
          }
          if (j.view_count !== undefined && j.view_count !== null) {
            lines.push(`- Views: ${j.view_count.toLocaleString ? j.view_count.toLocaleString() : j.view_count}`)
          }
          if (typeof j.upload_date === 'string' && j.upload_date.length >= 8) {
            const y = j.upload_date.slice(0, 4)
            const m = j.upload_date.slice(4, 6)
            const d = j.upload_date.slice(6, 8)
            lines.push(`- Uploaded: ${y}-${m}-${d}`)
          }
          if (Array.isArray(j.tags) && j.tags.length > 0) {
            lines.push(`- Tags: ${j.tags.slice(0, 12).join(', ')}`)
          }
          if (typeof j.description === 'string' && j.description.length > 0) {
            lines.push('')
            lines.push('## Description')
            lines.push('')
            lines.push(j.description.slice(0, BODY_CAP))
          }
        }
      } catch (e) { /* ignore parse */ }
    }
  }

  if (settled[1].status === 'fulfilled') {
    const r = settled[1].value
    if (r && r.exitCode === 0 && r.stdout) {
      const cleaned = cleanVtt(r.stdout)
      if (cleaned.length > 100) {
        lines.push('')
        lines.push('## Transcript')
        lines.push('')
        lines.push(cleaned.slice(0, BODY_CAP))
      }
    }
  }

  const body = lines.join('\n').trim() + '\n'
  return {
    url,
    statusCode: 200,
    body: { kind: 'html', content: body, extraction: 'youtube' },
    contentType: 'text/markdown',
    adapterId: id,
    truncated: body.length >= BODY_CAP,
    contentDigest: createHash('sha256').update(body).digest('hex'),
  }
}

/**
 * Strip WebVTT timestamps, cue identifiers, and HTML tags.
 *
 * @param {string} vtt
 * @returns {string}
 */
function cleanVtt(vtt) {
  if (typeof vtt !== 'string') return ''
  const lines = vtt.split(/\r?\n/)
  const out = []
  let skipping = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { out.push(''); continue }
    if (line.startsWith('WEBVTT')) continue
    if (/^\d+$/.test(line)) continue
    if (/^\d{2}:\d{2}/.test(line) && line.includes('-->')) continue
    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      skipping = true
      continue
    }
    if (skipping) { if (line === '') skipping = false; continue }
    const cleaned = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '').replace(/<[^>]+>/g, '').trim()
    if (cleaned) out.push(cleaned)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
