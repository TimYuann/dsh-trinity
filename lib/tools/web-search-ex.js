// lib/tools/web-search-ex.js — rich web search Tool (SPEC §II.5).
//
// routing: 'auto' | 'aggregate' | ProviderId | ProviderId[]
//   (no `provider: 'all'`; that's been renamed to routing='aggregate')
//   (no `reviewed-answer`; not implemented in v2.0)
//
// output: 'sources' | 'answer'
//   When output === 'answer', synthesises an answer from the collected
//   sources via the DSH llm seam (lib/llm-call.js). An empty tool belt is
//   passed to prevent recursion (P1 #15).

import { defineTool } from '../schema/define-tool.js'
import { chainedSearch } from '../providers/search/chained.js'
import { wrapProviderError } from '../errors.js'
import { oneShotCompletion } from '../llm-call.js'
import { toLosslessJson } from '../util/lossless-json.js'

export const TOOL_NAME = 'web_search_ex'

/**
 * Parameter shape (P0 #8): `routing` accepts a string OR an array of
 * strings per SPEC §I.4 #17. Strings must be 'auto', 'aggregate', or a
 * provider id; arrays are an explicit ordered list.
 *
 * DSH's local defineTool validator accepts JSON Schema fragments. We model
 * the union as `oneOf: [string, array]` with per-branch constraints.
 */
export const PARAMETERS = {
  query: { type: 'string', description: 'The search query (required when queries[] is absent)' },
  queries: { type: 'array', items: { type: 'string' }, description: 'Optional multi-query fan-out (each entry >= 1 char)' },
  routing: {
    // v2.2: the host rejects `type: 'json'` — union params must be `oneOf`.
    oneOf: [
      { type: 'string', description: "'auto' | 'aggregate' | a provider id" },
      { type: 'array', items: { type: 'string' }, description: 'an ordered list of provider ids' },
    ],
    description: "One of 'auto' | 'aggregate' | a provider id | an array of provider ids. Default 'auto'. (P0 #8: union per SPEC §I.4 #17.)",
  },
  output: {
    type: 'string',
    enum: ['sources', 'answer'],
    default: 'sources',
    description: "'sources' returns raw source list; 'answer' calls ctx.llm for synthesis",
  },
  maxResults: { type: 'integer', default: 8, description: '1-20 results' },
  recencyFilter: {
    type: 'string',
    enum: ['day', 'week', 'month', 'year'],
    description: 'Optional recency filter forwarded to the provider when supported',
  },
  domainFilter: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional domain filter',
  },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            publishedAt: { type: 'string' },
          },
        },
      },
      answer: { type: 'string' },
      truncated: { type: 'boolean' },
      provider: { type: 'string' },
      providerResponses: { type: 'array' },
      providerErrors: { type: 'array' },
    },
  },
  render(_args, value) {
    const blocks = []
    if (value && typeof value.answer === 'string' && value.answer.length > 0) {
      blocks.push({ type: 'text', text: value.answer })
    }
    if (value && Array.isArray(value.sources)) {
      for (const src of value.sources) {
        if (!src || typeof src.url !== 'string') continue
        const title = src.title ? src.title : src.url
        const parts = [`[${title}](${src.url})`]
        if (src.snippet) parts.push(` — ${src.snippet}`)
        if (src.publishedAt) parts.push(` (${src.publishedAt})`)
        blocks.push({ type: 'text', text: parts.join('') })
      }
    }
    if (value && Array.isArray(value.providerErrors) && value.providerErrors.length > 0) {
      blocks.push({
        type: 'text',
        text: '\n## Provider errors\n' + value.providerErrors.map((e) => `- ${e.provider}: ${e.error}`).join('\n'),
      })
    }
    return blocks
  },
}

/**
 * @param {{ ctx: any, settings?: any, chainedCtx?: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Rich web search. routing="auto" (default) uses the credential-pool chain; routing="aggregate" fans out across all eligible providers in parallel; routing=<providerId> pins a single provider. output="answer" calls ctx.llm to synthesise an answer from the sources. Prefer this tool over the DSH built-in `web_search` when you need richer behavior (routing modes, multi-query fan-out, AI answer). The built-in also routes through this plugin\'s chain via the configured namespaced provider but exposes only a single-provider thin wrapper.',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) throw abortError()
      // v2.3.0: routing is passed through unchanged. The single routing
      // parser in lib/providers/search/select-routing.js is the only
      // place that turns the raw value into the canonical shape.
      const routing = args.routing
      const output = args.output === 'answer' ? 'answer' : 'sources'
      const queries = Array.isArray(args.queries) ? args.queries.filter((q) => typeof q === 'string' && q.length > 0) : []
      const query = (typeof args.query === 'string' && args.query.trim().length > 0) ? args.query.trim() : ''
      const allQueries = queries.length > 0 ? queries : (query ? [query] : [])
      if (allQueries.length === 0) {
        throw toolError('web_search_ex', 'WEB_PROVIDER_BAD_REQUEST',
          "the 'query' field is required (non-empty string)",
          "pass query=\"...\" or queries=[\"q1\",\"q2\"]")
      }
      const maxResults = clampMaxResults(args.maxResults)

      const chainedCtx = opts && opts.chainedCtx
      if (!chainedCtx) {
        throw toolError('web_search_ex', 'MISSING_CTX',
          'chained ctx unavailable',
          'internal — file an issue with DSH Trinity')
      }

      // Multi-query fan-out: each query runs in sequence against the
      // chosen routing. Aggregate mode runs them in parallel inside the
      // chain runner.
      const merged = await runFanOut(allQueries, routing, maxResults, exec && exec.signal, chainedCtx)

      const out = {
        sources: merged.sources.slice(0, maxResults),
        truncated: merged.sources.length > maxResults,
        provider: merged.provider,
      }
      if (Array.isArray(merged.providerResponses) && merged.providerResponses.length > 0) {
        out.providerResponses = merged.providerResponses
      }
      if (Array.isArray(merged.providerErrors) && merged.providerErrors.length > 0) {
        out.providerErrors = merged.providerErrors
      }
      // When output='answer', synthesise via ctx.llm (with tool belt
      // scrubbed of web_search to prevent recursion).
      if (output === 'answer') {
        out.answer = await synthesiseAnswer(merged, opts, exec, query || (allQueries.length > 0 ? allQueries[0] : ''))
      } else if (typeof merged.content === 'string' && merged.content.length > 0) {
        out.answer = merged.content
      }
      // v2.2: sanitize at the boundary — provider payloads must never trip
      // the host's lossless-JSON validator.
      return toLosslessJson(out)
    },
  })
}

async function runFanOut(queries, routing, maxResults, signal, chainedCtx) {
  if (queries.length === 1) {
    return safeSearch({ query: queries[0], routing, maxResults }, signal, chainedCtx)
  }
  // Sequential fan-out per query — URL dedup across queries.
  const seen = new Set()
  const sources = []
  const providerResponses = []
  const providerErrors = []
  let lastProvider = 'chained'
  for (const q of queries) {
    try {
      const r = await safeSearch({ query: q, routing, maxResults }, signal, chainedCtx)
      lastProvider = r.provider
      for (const src of r.sources) {
        if (!seen.has(src.url)) {
          seen.add(src.url)
          sources.push(src)
        }
      }
      if (typeof r.content === 'string' && r.content.length > 0) {
        providerResponses.push({ provider: r.provider, query: q, answer: r.content })
      }
    } catch (e) {
      providerErrors.push({ provider: 'chained', query: q, error: e.message || String(e) })
    }
  }
  return {
    sources: sources.slice(0, maxResults),
    truncated: sources.length > maxResults,
    provider: 'chained:multi',
    providerResponses,
    providerErrors,
    content: providerResponses.map((r) => r.answer).filter(Boolean).join('\n\n'),
  }
}

async function safeSearch(request, signal, chainedCtx) {
  try {
    return await chainedSearch(request, signal, chainedCtx)
  } catch (e) {
    if (e && e.code === 'WEB_SEARCH_CHAIN_EXHAUSTED') {
      // Surface the structured failure to the model with the doctor
      // recommendation included. The attempts payload is sanitized so the
      // host's lossless-JSON validator can never reject the error.
      const err = new Error(`search chain exhausted; see attempts[] (${e.attempts.length} attempts)`)
      err.code = e.code
      err.attempts = toLosslessJson(e.attempts)
      err.doctorRecommended = true
      err.provider = 'chain'
      throw err
    }
    throw wrapProviderError('web_search_ex', e, "retry with a different query, or pin a specific provider via web_search_ex(routing='brave' | 'gemini' | 'tavily')")
  }
}

/** One-shot completion route guard — nothing to strip anymore: the DSH
 * prepareCall config carries no tool belt; the stream request passes an
 * explicit empty tools list to prevent recursion (P1 #15). */

async function synthesiseAnswer(merged, opts, exec, query) {
  const ctx = opts && opts.ctx
  if (!ctx || typeof ctx.get !== 'function') return merged.content || ''
  // Build a minimal prompt from sources. We do NOT include tool definitions
  // — output='answer' is a non-recursive completion (acceptance #17).
  const sourceBlock = merged.sources
    .map((s, i) => `${i + 1}. [${s.title || s.url}](${s.url})${s.snippet ? ' — ' + s.snippet : ''}`)
    .join('\n')
  const question = (typeof query === 'string' && query.length > 0) ? query : '(see conversation)'
  const prompt = `Answer the user's research question using ONLY the following sources. Cite source numbers inline.\n\nSources:\n${sourceBlock}\n\nQuestion: ${question}`
  const out = await oneShotCompletion(ctx, { prompt, tools: [] }, exec)
  // Fall back to whatever the upstream providers synthesised; never
  // crash the Tool.
  return out !== null ? out : (merged.content || '')
}

function clampMaxResults(v) {
  return Math.max(1, Math.min(20, Number(v) || 8))
}

/**
 * P0 #8: normalise the routing parameter to the canonical
 * 'auto' | 'aggregate' | { kind: 'single', id } | { kind: 'ordered', ids }
 * shape that chainedSearch's selectRouting consumes.
 *
 * Accepts:
 *   - undefined / null / 'auto'     → 'auto'
 *   - 'aggregate'                    → 'aggregate'
 *   - '<providerId>'                 → { kind: 'single', id }
 *   - ['<id>', '<id>', ...]          → { kind: 'ordered', ids } (or single)
 *
 * Throws ToolArgsError on garbage input — the schema (type:'json')
 * accepts any value at the DSH layer, so the Tool owns the validation.
 *
 * The single routing parser lives in
 * `lib/providers/search/select-routing.js`. web_search_ex no longer
 * pre-normalises the value here; chainedSearch rejects unknown ids
 * with `WEB_PROVIDER_BAD_REQUEST`.
 *
 * @deprecated kept only so older imports do not throw; do not use.
 */
function normaliseRouting(routing) {
  if (routing === undefined || routing === null) return 'auto'
  if (typeof routing === 'string') {
    if (routing.length === 0) return 'auto'
    if (routing === 'auto' || routing === 'aggregate') return routing
    return { kind: 'single', id: routing }
  }
  if (Array.isArray(routing)) {
    const ids = routing.filter((s) => typeof s === 'string' && s.length > 0)
    if (ids.length === 0) return 'auto'
    if (ids.length === 1) return { kind: 'single', id: ids[0] }
    return { kind: 'ordered', ids }
  }
  return 'auto'
}

function abortError() {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  e.code = 'ABORTED'
  return e
}

function toolError(tool, code, what, advice) {
  const e = new Error(`[${tool}] ${what} | CODE: ${code} | TRY: ${advice}`)
  e.tool = tool
  e.code = code
  e.advice = advice
  return e
}
