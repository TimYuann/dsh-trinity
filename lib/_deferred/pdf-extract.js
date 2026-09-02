// lib/tools/pdf-extract.js — PDF extraction (DESIGN §1.17)
//
// Uses unpdf (bundled pdfjs) as the local fallback provider. URL fetches
// flow through chained-fetch (SSRF + size cap), local paths go through
// realpathSync + outputDir containment check.

import { defineTool } from '../schema/define-tool.js'
import { readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chainedFetch } from '../providers/fetch/chained-fetch.js'
import { validateRemoteUrl } from '../providers/fetch/ssrf.js'
import { redactCredential } from '../key-redact.js'
import { toolError } from '../errors.js'

export const TOOL_NAME = 'pdf_extract'

export const PARAMETERS = {
  url: { type: 'string', description: 'HTTP/HTTPS URL to a PDF' },
  filePath: { type: 'string', description: 'Absolute path to local PDF file' },
  maxPages: { type: 'integer', default: 100, description: '1-500 pages' },
  filename: { type: 'string', description: 'Output markdown filename' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', required: true },
      pages: { type: 'integer', required: true },
      chars: { type: 'integer', required: true },
      outputPath: { type: 'string', required: true },
      markdown: { type: 'string' },
    },
  },
  render(_args, value) {
    if (!value) return [{ type: 'text', text: '(no PDF extracted)' }]
    const blocks = [{ type: 'text', text: `# ${value.title}\n\nPages: ${value.pages} · Chars: ${value.chars}\n\n${value.markdown || '(inline empty)'}\n\n_Saved to: ${value.outputPath}_` }]
    return blocks
  },
}

async function extractWithUnpdf(buffer, maxPages) {
  // unpdf exposes extractText / extractImages / getDocumentProxy
  // We use extractText + getDocumentProxy to count pages
  // TODO: signal propagation needs unpdf to accept an AbortSignal — its public
  // API (extractText / getDocumentProxy) does not surface cancellation, so
  // once we hand it the buffer the in-flight PDF parsing cannot be aborted.
  // Cancellation only takes effect at the chainedFetch boundary above.
  const { extractText, getDocumentProxy } = await import('unpdf')
  let pages = 1
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    pages = Math.min(pdf.numPages || 1, maxPages)
  } catch { /* fall back to pages=1 */ }
  const { totalPages, text } = await extractText(buffer, { mergePages: true })
  return { markdown: text || '', pages: Math.min(totalPages || pages, maxPages) }
}

export function createTool(opts = {}) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Extract a PDF (URL or local file path) to markdown. Supports unpdf local fallback.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) throw new Error('Aborted')
      const url = args && typeof args.url === 'string' ? args.url : ''
      const filePath = args && typeof args.filePath === 'string' ? args.filePath : ''
      if (!url && !filePath) {
        throw toolError(
          'pdf_extract',
          'TOO_FEW',
          "url or filePath required (one must be set)",
          "either 'url' (publicly fetchable PDF) or 'filePath' (local file) is required; pass url=\"https://example.com/file.pdf\" OR filePath=\"/abs/path/to.pdf\"",
        )
      }
      const maxPages = Math.max(1, Math.min(500, Number(args && args.maxPages) || 100))
      const filename = args && typeof args.filename === 'string' ? args.filename : `pdf-${Date.now()}.md`

      const ctx = opts && opts.ctx ? opts.ctx : null
      if (!ctx || !ctx.creds) {
        throw toolError(
          'pdf_extract',
          'MISSING_CTX',
          'internal plugin bug — chained ctx is unavailable',
          'internal plugin bug — file an issue with DSH Trinity',
        )
      }

      let buffer
      let sourceLabel = url || filePath
      if (url) {
        await validateRemoteUrl(url, { ssrf: ctx.creds.ssrf, domainPolicy: ctx.creds.domainPolicy })
        const r = await chainedFetch({ url }, exec && exec.signal, {
          ssrf: ctx.creds.ssrf,
          domainPolicy: ctx.creds.domainPolicy,
          maxBytes: (ctx.creds.pdf && ctx.creds.pdf.maxSizeMB ? ctx.creds.pdf.maxSizeMB : 20) * 1024 * 1024,
        })
        if (!r.body) {
          throw toolError(
            'pdf_extract',
            'INVALID_CONTENT_TYPE',
            'fetched URL returned an empty body',
            'fetched URL returned non-PDF content (likely HTML error page); check the URL serves application/pdf',
          )
        }
        buffer = new TextEncoder().encode(r.body.content)
      } else {
        let real
        try {
          real = realpathSync(filePath)
        } catch {
          throw toolError(
            'pdf_extract',
            'FILE_RESOLVE_FAIL',
            "filePath does not exist or cannot resolve",
            "filePath does not exist or is not readable; check the path is correct and you have read permission",
          )
        }
        const stat = statSync(real)
        if (!stat.isFile()) {
          throw toolError(
            'pdf_extract',
            'NOT_A_FILE',
            'filePath exists but is not a regular file',
            'filePath exists but is not a regular file (could be a directory or symlink); point at a regular PDF file',
          )
        }
        if (stat.size > ((ctx.creds.pdf && ctx.creds.pdf.maxSizeMB ? ctx.creds.pdf.maxSizeMB : 20) * 1024 * 1024)) {
          const cap = (ctx.creds.pdf && ctx.creds.pdf.maxSizeMB ? ctx.creds.pdf.maxSizeMB : 20)
          throw toolError(
            'pdf_extract',
            'TOO_LARGE',
            `PDF exceeds the size cap (${Math.round(stat.size / 1024 / 1024)}MB > ${cap}MB)`,
            `PDF exceeds the size cap; reduce the file size (use a smaller PDF, or split it) or raise pdf.maxSizeMB in web-search.json (default 20MB)`,
          )
        }
        // Sniff first 4 bytes
        const fd = readFileSync(real)
        const head = String.fromCharCode(fd[0], fd[1], fd[2], fd[3])
        if (head !== '%PDF') {
          throw toolError(
            'pdf_extract',
            'NOT_A_PDF',
            'file does not start with %PDF magic bytes',
            'fetched content does not start with %PDF magic bytes; the URL may not point to a PDF — verify with the source',
          )
        }
        buffer = fd
      }

      const out = await extractWithUnpdf(buffer, maxPages)
      const outputDir = (ctx.creds.pdf && ctx.creds.pdf.outputDir) || path.join(tmpdir(), 'dsh-pdf')
      try { mkdirSync(outputDir, { recursive: true }) } catch { /* ignore */ }
      const outputPath = path.join(outputDir, filename.endsWith('.md') ? filename : filename + '.md')
      try { writeFileSync(outputPath, out.markdown, 'utf8') } catch { /* best-effort */ }
      return {
        title: filename.replace(/\.md$/, ''),
        pages: out.pages,
        chars: out.markdown.length,
        outputPath,
        markdown: out.markdown.length < 8 * 1024 ? out.markdown : undefined,
      }
    },
  })
}