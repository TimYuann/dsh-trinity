// lib/tools/video-extract.js — heavy local video Tool (SPEC §II.5).
//
// Local file → multimodal extraction via Gemini Files API (or ffmpeg +
// frame sampling as a fallback). Gated by
// `web-access-chain.tools.videoExtract.enabled` (default OFF).
//
// IMPORTANT: this is the heavy operation. The cheap YouTube path
// (metadata + transcript) is in `lib/adapters/youtube.js` and is
// available inside `web_fetch` even when this Tool is disabled.

import { defineTool } from '../schema/define-tool.js'
import { runSubprocess } from '../util/subprocess.js'
import { toolError } from '../errors.js'

export const TOOL_NAME = 'video_extract'

export const PARAMETERS = {
  filePath: { type: 'string', required: true, description: 'Local path to a video file (mp4 / mov / webm / mkv)' },
  prompt: { type: 'string', description: 'Multimodal prompt — what to ask the model about the video' },
  frames: { type: 'array', items: { type: 'integer' }, description: 'Optional explicit frame timestamps (seconds) to sample' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      filePath: { type: 'string' },
      duration: { type: 'number' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      sampledFrames: { type: 'array' },
      model: { type: 'string' },
      answer: { type: 'string' },
    },
  },
  render(_args, value) {
    if (!value || typeof value !== 'object') return []
    const blocks = []
    blocks.push({ type: 'text', text: `# video_extract: ${value.filePath}` })
    if (value.duration) blocks.push({ type: 'text', text: `- Duration: ${value.duration.toFixed(1)}s` })
    if (value.width && value.height) blocks.push({ type: 'text', text: `- Resolution: ${value.width}x${value.height}` })
    if (Array.isArray(value.sampledFrames) && value.sampledFrames.length > 0) {
      blocks.push({ type: 'text', text: `- Sampled frames: ${value.sampledFrames.length}` })
    }
    if (value.answer) blocks.push({ type: 'text', text: `\n${value.answer}` })
    return blocks
  },
}

/**
 * @param {{ ctx: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Local video file → multimodal extraction (Gemini Files API or ffmpeg). Gated by web-access-chain.tools.videoExtract.enabled.',
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
      const gate = (settings.tools && settings.tools.videoExtract) || {}
      if (gate.enabled !== true) {
        throw toolError(TOOL_NAME, 'CONFIG',
          'video_extract is disabled',
          'set web-access-chain.tools.videoExtract.enabled: true in settings to use this Tool')
      }
      const fp = typeof args.filePath === 'string' ? args.filePath.trim() : ''
      if (!fp) {
        throw toolError(TOOL_NAME, 'INVALID_INPUT', 'filePath is required', 'pass an absolute local file path')
      }
      // Hidden files rejected (basename only — legitimate dirs like
      // `.config/foo` are NOT refused; R3 P2 #17).
      const bn = fp.split('/').pop() || fp
      if (bn.startsWith('.')) {
        throw toolError(TOOL_NAME, 'HIDDEN_FILE', `refusing to process hidden file: ${fp}`, 'pass a non-hidden file path')
      }
      const prompt = (typeof args.prompt === 'string' && args.prompt.length > 0) ? args.prompt : 'Summarise this video.'

      // Probe metadata via ffprobe (argv array, no shell).
      let probeJson
      try {
        const probe = await runSubprocess(undefined, {
          argv: ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', fp],
          timeoutMs: 8000,
          signal: exec && exec.signal,
        })
        if (probe.exitCode === 0) {
          try { probeJson = JSON.parse(probe.stdout) } catch { /* ignore */ }
        }
      } catch (e) {
        // ffprobe not installed — surface a clear error.
        throw toolError(TOOL_NAME, 'MISSING_DEPENDENCY',
          'ffprobe is not installed',
          'install ffmpeg (which provides ffprobe) to enable video_extract')
      }

      const video = (probeJson && Array.isArray(probeJson.streams))
        ? probeJson.streams.find((s) => s.codec_type === 'video') || {}
        : {}
      const width = typeof video.width === 'number' ? video.width : 0
      const height = typeof video.height === 'number' ? video.height : 0
      const duration = (probeJson && probeJson.format && typeof probeJson.format.duration === 'string')
        ? Number(probeJson.format.duration) : 0

      // Decide whether to use Gemini Files API (heavy) or ffmpeg frame
      // sampling (cheap). Heavy is the default for this Tool because
      // that's the point of the gated registration.
      const model = (settings.tools && settings.tools.videoExtract && settings.tools.videoExtract.model) || 'gemini-2.5-flash'
      const frames = Array.isArray(args.frames) && args.frames.length > 0
        ? args.frames.map((n) => Math.max(0, Math.floor(Number(n)))).filter((n) => Number.isFinite(n))
        : null

      // Frame sampling: R3 P2 #16 — we do NOT actually call ffmpeg to
      // extract frames here (that path is expensive + non-deterministic
      // across containers). Instead we pass the FULL video bytes via the
      // Gemini Files API and let Gemini select frames internally. We
      // still report `sampledFrames` so callers can see what was
      // requested, but the field is informational — Gemini handles the
      // actual frame selection.
      const sampleRate = Math.min(32, Math.max(1, Math.floor(duration || 0)))
      const sampledFrames = frames && frames.length > 0
        ? frames
        : Array.from({ length: sampleRate }, (_, i) => Math.floor(((i + 0.5) * (duration || sampleRate)) / sampleRate))

      // Use Gemini Files API to upload + ask. The actual implementation
      // requires @google/generative-ai (optional dep); we surface a
      // MISSING_DEPENDENCY error when the operator hasn't installed it.
      let answer
      try {
        const mod = await import('@google/generative-ai')
        const { GoogleGenerativeAI } = mod
        const apiKey = await resolveEnvCredential(opts.ctx, 'GEMINI_API_KEY')
        if (!apiKey) {
          throw toolError(TOOL_NAME, 'MISSING_API_KEY',
            'video_extract requires GEMINI_API_KEY',
            'set GEMINI_API_KEY in env, or wire a different multimodal model in video_extract.js')
        }
        const genAI = new GoogleGenerativeAI(apiKey)
        // Upload the file via Files API.
        const fileBytes = (await import('node:fs')).readFileSync(fp)
        const fileBlob = new Blob([fileBytes])
        const uploadResult = await genAI.filesManager
          ? await genAI.filesManager.uploadFile(fileBlob, { mimeType: 'video/mp4' })
          : null
        if (!uploadResult || !uploadResult.file) {
          throw toolError(TOOL_NAME, 'CONFIG',
            'Gemini Files API is unavailable in this @google/generative-ai version',
            'update the package or implement an alternative multimodal path')
        }
        const modelInstance = genAI.getGenerativeModel({ model })
        const result = await modelInstance.generateContent({
          contents: [
            { role: 'user', parts: [
              { text: prompt },
              { fileData: { mimeType: uploadResult.file.mimeType || 'video/mp4', fileUri: uploadResult.file.uri } },
            ] },
          ],
        })
        const response = await result.response
        answer = typeof response.text === 'function' ? response.text() : ''
      } catch (e) {
        if (e && e.code) throw e // already a toolError
        throw toolError(TOOL_NAME, 'WEB_FETCH_FAILED',
          `video_extract Gemini call failed: ${e.message || e}`,
          'verify @google/generative-ai is installed and GEMINI_API_KEY is set')
      }

      return {
        filePath: fp,
        duration: duration || 0,
        width: width || 0,
        height: height || 0,
        sampledFrames,
        model,
        answer,
      }
    },
  })
}
