// lib/tools/pdf-extract.js — heavy PDF Tool (SPEC §II.5).
//
// URL or filePath → markdown via unpdf (cheap), Datalab, or Gemini.
// Gated by `web-access-chain.tools.pdfExtract.enabled` (default OFF).
//
// The cheap default `provider: 'unpdf'` is the same backend the
// PDF ContentAdapter uses — but this Tool is the **public** entry point
// (the user invokes it explicitly) while the adapter is what
// `web_fetch` calls inside the content-type dispatch path.

import { defineTool } from '../schema/define-tool.js'
import { toolError } from '../errors.js'
import { createHash } from 'node:crypto'
import { safeHttpFetch } from '../util/safe-http-fetch.js'

export const TOOL_NAME = 'pdf_extract'

export const PARAMETERS = {
  url: { type: 'string', description: 'Remote PDF URL (mutually exclusive with filePath)' },
  filePath: { type: 'string', description: 'Local PDF file path (mutually exclusive with url)' },
  maxPages: { type: 'integer', description: 'Cap on pages extracted (default 20)' },
  provider: {
    type: 'string',
    enum: ['unpdf', 'datalab', 'gemini'],
    default: 'unpdf',
    description: "Backend: 'unpdf' (cheap, default) | 'datalab' (heavy) | 'gemini' (heavy multimodal)",
  },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string' },
      filePath: { type: 'string' },
      provider: { type: 'string' },
      totalPages: { type: 'integer' },
      contentDigest: { type: 'string' },
      content: { type: 'string' },
    },
  },
  render(_args, value) {
    if (!value || typeof value !== 'object') return []
    const blocks = []
    blocks.push({ type: 'text', text: `# pdf_extract (${value.provider})` })
    if (value.url) blocks.push({ type: 'text', text: `URL: ${value.url}` })
    if (value.filePath) blocks.push({ type: 'text', text: `File: ${value.filePath}` })
    if (value.totalPages !== undefined) blocks.push({ type: 'text', text: `- Total pages: ${value.totalPages}` })
    if (value.contentDigest) blocks.push({ type: 'text', text: `- contentDigest: ${value.contentDigest}` })
    if (value.content) blocks.push({ type: 'text', text: `\n${value.content}` })
    return blocks
  },
}

const HARD_BODY_CAP = 20_000

/**
 * @param {{ ctx: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'URL or local file → PDF markdown extraction. Gated by web-access-chain.tools.pdfExtract.enabled. Provider: unpdf (default) / datalab / gemini.',
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
      const gate = (settings.tools && settings.tools.pdfExtract) || {}
      if (gate.enabled !== true) {
        throw toolError(TOOL_NAME, 'CONFIG',
          'pdf_extract is disabled',
          'set web-access-chain.tools.pdfExtract.enabled: true in settings to use this Tool')
      }
      if ((args.url ? 1 : 0) + (args.filePath ? 1 : 0) !== 1) {
        throw toolError(TOOL_NAME, 'INVALID_INPUT',
          'exactly one of { url, filePath } must be supplied',
          'pass either url (remote PDF) or filePath (local PDF); not both, not neither')
      }
      const provider = (typeof args.provider === 'string' && args.provider.length > 0) ? args.provider : (gate.provider || 'unpdf')
      const maxPages = (typeof args.maxPages === 'number' && args.maxPages > 0)
        ? Math.floor(args.maxPages)
        : (typeof gate.maxPages === 'number' && gate.maxPages > 0 ? Math.floor(gate.maxPages) : 20)

      let bytes
      if (args.filePath) {
        const fp = String(args.filePath)
        // R3 P2 #17: hidden-file guard checks basename only, so legitimate
        // directories like `.config/foo` are NOT refused.
        const bn = fp.split('/').pop() || fp
        if (bn.startsWith('.')) {
          throw toolError(TOOL_NAME, 'HIDDEN_FILE', `refusing to process hidden file: ${fp}`, 'pass a non-hidden file path')
        }
        const fs = await import('node:fs')
        bytes = await fs.promises.readFile(fp)
      } else {
        const url = String(args.url)
        // R3 P1 #10: safeHttpFetch validates per-redirect-hop against the
        // SSRF / domain policy (SPEC §II.7). Raw `fetch(url, { redirect:
        // 'follow' })` was a hole.
        const ssrf = (settings && settings.ssrf) || { allowRanges: [], trustEnvProxy: false }
        const domainPolicy = (settings && settings.domainPolicy) || { allow: [], deny: [] }
        let safe
        try {
          safe = await safeHttpFetch(url, { ssrf, domainPolicy, signal: exec && exec.signal })
        } catch (e) {
          throw toolError(TOOL_NAME,
            e && e.code ? e.code : 'WEB_FETCH_FAILED',
            `pdf url fetch failed: ${e.message || e}`,
            'check the URL is reachable')
        }
        const response = safe.response
        if (!response.ok) {
          throw toolError(TOOL_NAME, 'HTTP_' + response.status, `pdf url returned HTTP ${response.status}`, 'verify the URL serves a PDF')
        }
        bytes = new Uint8Array(await response.arrayBuffer())
      }
      if (bytes.length === 0) {
        throw toolError(TOOL_NAME, 'EMPTY_RESULTS', 'PDF body is empty', 'verify the URL/file is a non-empty PDF')
      }

      let result
      if (provider === 'unpdf') {
        result = await extractUnpdf(bytes, maxPages)
      } else if (provider === 'datalab') {
        result = await extractDatalab(bytes, opts.ctx, settings, exec)
      } else if (provider === 'gemini') {
        result = await extractGemini(bytes, opts.ctx, settings, exec)
      } else {
        throw toolError(TOOL_NAME, 'CONFIG', `unknown provider: ${provider}`, 'set provider to "unpdf" | "datalab" | "gemini"')
      }

      return {
        url: args.url,
        filePath: args.filePath,
        provider,
        totalPages: result.totalPages,
        // R3 P0 #5: contentDigest is sha256 hex of the RAW BYTES (SPEC
        // §II.3.4), NOT of the parsed text. Cache lookups keyed on
        // `bytes digest` will match the source PDF regardless of which
        // parser extracted which text.
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
        content: result.text,
      }
    },
  })
}

async function extractUnpdf(bytes, maxPages) {
  let unpdf
  try { unpdf = await import('unpdf') } catch (e) {
    throw toolError('pdf_extract', 'MISSING_DEPENDENCY',
      `unpdf is not installed: ${e.message || e}`, 'run `pnpm add unpdf`')
  }
  let parsed
  try { parsed = await unpdf.extractText(bytes, { mergePages: false }) } catch (e) {
    throw toolError('pdf_extract', 'INVALID_CONTENT_TYPE', `PDF parse failed: ${e.message || e}`, 'verify the bytes are a valid PDF')
  }
  // unpdf mergePages:false returns { totalPages, text: string[] } — one entry per page
  const totalPages = (parsed && typeof parsed.totalPages === 'number') ? parsed.totalPages : 0
  const pages = Array.isArray(parsed.text) ? parsed.text : []
  const cap = Math.min(maxPages, totalPages || pages.length)
  const text = pages.slice(0, cap).join('\n\n')
  return { totalPages, text: text.slice(0, HARD_BODY_CAP) }
}

async function extractDatalab(bytes, ctx, settings, exec) {
  // Heavy path — needs DATALAB_API_KEY. Surface clear MISSING_DEPENDENCY
  // / MISSING_API_KEY when the operator hasn't configured it. The key
  // resolves through the DSH credentials seam (store / env / .env).
  const apiKey = await resolveEnvCredential(ctx, 'DATALAB_API_KEY')
  if (!apiKey) {
    throw toolError('pdf_extract', 'MISSING_API_KEY',
      'pdf_extract provider=datalab requires DATALAB_API_KEY',
      'set DATALAB_API_KEY, or switch provider to "unpdf" (cheap default)')
  }
  const form = new FormData()
  form.append('file', new Blob([bytes]), 'document.pdf')
  form.append('mode', 'markdown')
  let response
  try {
    response = await fetch('https://api.datalab.to/v1/pdf', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
      signal: exec && exec.signal,
    })
  } catch (e) {
    throw toolError('pdf_extract', 'WEB_FETCH_FAILED', `datalab fetch failed: ${e.message || e}`, 'check connectivity')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw toolError('pdf_extract', 'HTTP_' + response.status,
      `datalab returned ${response.status}: ${text.slice(0, 200)}`, 'verify DATALAB_API_KEY and try provider=unpdf')
  }
  const j = await response.json().catch(() => ({}))
  return { totalPages: 0, text: String((j && j.markdown) || '').slice(0, HARD_BODY_CAP) }
}

async function extractGemini(bytes, ctx, settings, exec) {
  // Key resolves through the DSH credentials seam (store / env / .env).
  const apiKey = await resolveEnvCredential(ctx, 'GEMINI_API_KEY')
  if (!apiKey) {
    throw toolError('pdf_extract', 'MISSING_API_KEY',
      'pdf_extract provider=gemini requires GEMINI_API_KEY',
      'set GEMINI_API_KEY, or switch provider to "unpdf" (cheap default)')
  }
  let mod
  try { mod = await import('@google/generative-ai') } catch (e) {
    throw toolError('pdf_extract', 'MISSING_DEPENDENCY',
      `@google/generative-ai is not installed: ${e.message || e}`,
      'run `pnpm add @google/generative-ai`')
  }
  const { GoogleGenerativeAI } = mod
  const genAI = new GoogleGenerativeAI(apiKey)
  const modelInstance = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
  const fileBytes = Buffer.from(bytes)
  const fileBlob = new Blob([fileBytes], { type: 'application/pdf' })
  const upload = await genAI.filesManager
    ? await genAI.filesManager.uploadFile(fileBlob, { mimeType: 'application/pdf' })
    : null
  if (!upload || !upload.file) {
    throw toolError('pdf_extract', 'CONFIG',
      'Gemini Files API is unavailable in this @google/generative-ai version',
      'pin a compatible @google/generative-ai version or switch to unpdf')
  }
  const result = await modelInstance.generateContent({
    contents: [{ role: 'user', parts: [
      { text: 'Extract the document as markdown. Preserve headings and lists.' },
      { fileData: { mimeType: 'application/pdf', fileUri: upload.file.uri } },
    ] }],
  })
  const response = await result.response
  const text = typeof response.text === 'function' ? response.text() : ''
  return { totalPages: 0, text: text.slice(0, HARD_BODY_CAP) }
}
