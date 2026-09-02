// lib/tools/search-content.js — search_content Tool (SPEC §II.5).
//
// Retrieves cached payloads by cacheRef with optional offset / limit /
// findText (mutually exclusive with offset/limit). Hard cap: 20 000 chars
// (no `maxInlineContentChars` config field; that is DSH's toolResultPruner
// concern, not ours — SPEC §II.3.4 / acceptance #15).

import { defineTool } from '../schema/define-tool.js'
import { readEntryContent } from '../cache/index.js'
import { webError, toolError } from '../errors.js'
import { toLosslessJson } from '../util/lossless-json.js'

export const TOOL_NAME = 'search_content'

export const PARAMETERS = {
  cacheRef: { type: 'string', required: true, description: 'cacheRef returned by source_check (evidenceSnapshotRefs[].cacheRef)' },
  sourceIndex: { type: 'integer', description: 'Select one of entry.sources[]' },
  offset: { type: 'integer', description: 'Character offset (mutually exclusive with findText)' },
  limit: { type: 'integer', description: 'Character limit (mutually exclusive with findText)' },
  findText: { type: 'string', description: 'Find passages containing this text (mutually exclusive with offset / limit)' },
  findMode: {
    type: 'string',
    enum: ['exact', 'case-insensitive', 'fuzzy'],
    description: 'Search mode for findText',
  },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { type: 'string' },
      totalChars: { type: 'integer' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            offset: { type: 'integer' },
            length: { type: 'integer' },
          },
        },
      },
    },
  },
  render(_args, value) {
    if (!value || typeof value.content !== 'string') return []
    const blocks = []
    if (value.totalChars !== undefined) {
      blocks.push({ type: 'text', text: `(${value.totalChars} chars total)\n` })
    }
    blocks.push({ type: 'text', text: value.content })
    if (Array.isArray(value.matches) && value.matches.length > 0) {
      blocks.push({ type: 'text', text: `\nMatches:\n${value.matches.map((m, i) => `${i + 1}. offset ${m.offset} length ${m.length}`).join('\n')}` })
    }
    return blocks
  },
}

/**
 * @param {{ ctx: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Retrieve a cached payload by cacheRef (cacheRef values are produced by source_check as evidenceSnapshotRefs[].cacheRef; web_search_ex and web_fetch do NOT produce cacheRefs). Supports offset/limit slicing or findText passage search. Prefer this tool over the DSH built-in `web_fetch` when you need richer behavior (specialised adapters for GitHub, YouTube, RSS, PDF; cached payload slicing; passage search). The built-in also routes through this plugin\'s chain but is a thin single-fetch wrapper.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) {
        const e = new Error('Aborted')
        e.name = 'AbortError'
        e.code = 'ABORTED'
        throw e
      }
      const ctx = opts && opts.ctx
      if (!ctx) {
        throw toolError('search_content', 'MISSING_CTX', 'ctx unavailable', 'internal')
      }
      const cacheRef = typeof args.cacheRef === 'string' ? args.cacheRef.trim() : ''
      if (!cacheRef) {
        throw toolError('search_content', 'INVALID_INPUT', 'cacheRef is required', 'pass a cacheRef from source_check evidenceSnapshotRefs[].cacheRef')
      }
      try {
        // v2.2: sanitize at the boundary (lossless-JSON contract).
        return toLosslessJson(await readEntryContent(ctx, cacheRef, {
          sourceIndex: args.sourceIndex,
          offset: args.offset,
          limit: args.limit,
          findText: args.findText,
          findMode: args.findMode,
        }))
      } catch (e) {
        if (e && e.code === 'WEB_CONTENT_FORBIDDEN') {
          throw webError('WEB_CONTENT_FORBIDDEN', e.message || 'cache scope mismatch',
            'this cache entry is not visible to the current session — re-fetch the URL')
        }
        if (e && (e.code === 'WEB_CONTENT_NOT_FOUND' || e.code === 'WEB_CONTENT_EXPIRED')) {
          throw e
        }
        throw toolError('search_content', 'INTERNAL_BUG', e.message || String(e),
          're-fetch the URL or check web_doctor')
      }
    },
  })
}
