// lib/tools/source-check.js — claim verification Tool (SPEC §II.5,
// acceptance #20).
//
// Algorithm:
//   1. Query generation — sub-queries via ctx.llm (or heuristic)
//   2. Search — run each through auto chain via web_search_ex
//   3. Fetch — top maxPages distinct URLs through web_fetch (cache entry per page)
//   4. Passage selection — score passages, keep top N per page
//   5. Assessment — ctx.llm with passages → supported|contradicted|mixed|insufficient
//   6. Snapshot refs — every fetched page has its own cacheRef

import { defineTool } from '../schema/define-tool.js'
import { decomposeClaim } from '../source-check/decompose.js'
import { scorePassages } from '../source-check/score.js'
import { assessClaim } from '../source-check/assess.js'
import { toLosslessJson } from '../util/lossless-json.js'
import { put } from '../cache/index.js'
import { chainedSearch } from '../providers/search/chained.js'
import { chainedFetch } from '../providers/fetch/chained-fetch.js'
import { toolError } from '../errors.js'

export const TOOL_NAME = 'source_check'

export const PARAMETERS = {
  claim: { type: 'string', required: true, description: 'The claim to verify' },
  subQueries: { type: 'array', items: { type: 'string' }, description: 'Optional pre-generated sub-queries (overrides step 1)' },
  maxPages: { type: 'integer', description: 'Max distinct URLs to fetch (default from settings)' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      claim: { type: 'string' },
      subQueries: { type: 'array', items: { type: 'string' } },
      assessment: { type: 'string' },
      assessmentModel: { type: 'string' },
      assessmentGeneratedAt: { type: 'integer' },
      evidenceSnapshotRefs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cacheRef: { type: 'string' },
            url: { type: 'string' },
            contentDigest: { type: 'string' },
            passages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  offset: { type: 'integer' },
                  length: { type: 'integer' },
                  text: { type: 'string' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  render(_args, value) {
    if (!value || typeof value !== 'object') return []
    const blocks = []
    if (typeof value.assessment === 'string') {
      blocks.push({ type: 'text', text: `Assessment: ${value.assessment}` })
    }
    if (Array.isArray(value.subQueries)) {
      blocks.push({ type: 'text', text: '\nSub-queries:\n' + value.subQueries.map((q, i) => `${i + 1}. ${q}`).join('\n') })
    }
    if (Array.isArray(value.evidenceSnapshotRefs) && value.evidenceSnapshotRefs.length > 0) {
      blocks.push({ type: 'text', text: '\nEvidence snapshots:' })
      for (const r of value.evidenceSnapshotRefs) {
        blocks.push({
          type: 'text',
          text: `  - ${r.url} (cacheRef: ${r.cacheRef}, digest: ${r.contentDigest ? r.contentDigest.slice(0, 12) : '?'})`,
        })
        for (const p of (r.passages || [])) {
          blocks.push({
            type: 'text',
            text: `      [${p.label}] (offset ${p.offset}, ${p.length} chars) ${p.text.slice(0, 200)}${p.text.length > 200 ? '…' : ''}`,
          })
        }
      }
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
    description: 'Verify a claim by decomposing into sub-queries, searching, fetching top pages, scoring passages, and assessing via LLM. Returns immutable cacheRef snapshots for each fetched page. This is a DSH Trinity-specific tool (no DSH built-in equivalent) — use it whenever the user asks whether a claim is supported by sources.',
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
      const settings = (opts && opts.settings) || {}
      const sourceCheckCfg = settings.sourceCheck || {}
      if (sourceCheckCfg.enabled === false) {
        throw toolError('source_check', 'INTERNAL_BUG', 'source_check is disabled', 'enable it under web-access-chain.sourceCheck.enabled')
      }
      if (typeof args.claim !== 'string' || args.claim.trim().length === 0) {
        throw toolError('source_check', 'INVALID_INPUT', 'claim is required', 'pass a non-empty claim string')
      }
      const claim = args.claim.trim()
      const maxPages = clampInt(args.maxPages, sourceCheckCfg.maxPagesFetch || 5, 1, 10)
      const subQueryCount = clampInt(sourceCheckCfg.subQueryCount, 3, 1, 6)
      const topN = clampInt(sourceCheckCfg.topPassagesPerSource, 3, 1, 10)

      // 1. Sub-queries
      let subQueries = Array.isArray(args.subQueries) ? args.subQueries.filter((s) => typeof s === 'string' && s.length > 0) : []
      if (subQueries.length === 0) {
        subQueries = await decomposeClaim(claim, subQueryCount, opts, exec)
      }
      subQueries = subQueries.slice(0, Math.max(2, Math.min(6, subQueryCount)))

      // 2. Search via the auto chain
      const allUrls = new Map() // url → { title, snippet, query }
      for (const sq of subQueries) {
        try {
          const r = await chainedSearch({ query: sq, maxResults: 8, routing: 'auto' }, exec && exec.signal, opts.chainedCtx)
          for (const src of (r.sources || [])) {
            if (!allUrls.has(src.url)) {
              allUrls.set(src.url, { ...src, queries: [sq] })
            } else {
              allUrls.get(src.url).queries.push(sq)
            }
          }
          if (process.env.DSH_DEBUG) {
            console.error(`[source_check] sub-query "${sq}" → ${(r.sources || []).length} sources (provider ${r.provider})`)
          }
        } catch (e) {
          // Continue — at least one sub-query may succeed.
          if (process.env.DSH_DEBUG) {
            console.error(`[source_check] sub-query search failed: "${sq}" → ${e && e.code ? e.code : ''} ${e && e.message ? e.message : e}`.slice(0, 400))
          }
        }
      }

      // 3. Fetch top URLs (each becomes an immutable page cache entry).
      const urls = Array.from(allUrls.keys()).slice(0, maxPages)
      const evidence = []
      for (const url of urls) {
        if (exec && exec.signal && exec.signal.aborted) break
        try {
          const fetched = await chainedFetch({ url }, exec && exec.signal, {
            ssrf: settings.ssrf || { allowRanges: [], trustEnvProxy: false },
            domainPolicy: settings.domainPolicy || { allow: [], deny: [] },
            maxBytes: ((settings.fetchMaxResponseMB || 5) * 1024 * 1024),
            settings,
            ctx,
          })
          if (!fetched || !fetched.body || typeof fetched.body.content !== 'string') {
            if (process.env.DSH_DEBUG) console.error(`[source_check] fetch returned no content for ${url}`)
            continue
          }
          // 4. Score passages.
          const passages = scorePassages(fetched.body.content, claim, subQueries, topN)
          // Persist the page as an immutable cache entry. The cacheRef is
          // the snapshot ref returned to the model.
          const inline = fetched.body.content.slice(0, 1_048_576) // 1 MiB max inline
          const { cacheRef, entry } = await put(ctx, {
            kind: 'page',
            authenticated: false,
            sources: [{ url, contentDigest: fetched.contentDigest || '', fetchedAt: Date.now() }],
            inlineContent: inline,
            ttlMs: (settings.cacheTtlMs || 3600000),
          })
          evidence.push({
            cacheRef,
            url,
            contentDigest: fetched.contentDigest || '',
            passages: passages.map((p) => ({
              offset: p.offset,
              length: p.length,
              text: p.text,
              label: p.label === 'contradicting' ? 'contradicting' : (p.label === 'supporting' ? 'supporting' : 'supporting'),
              score: p.score,
            })),
            _entry: entry,
          })
        } catch (e) {
          // Skip; this URL's evidence is lost but the chain continues.
          if (process.env.DSH_DEBUG) {
            console.error(`[source_check] fetch failed: ${url} → ${e && e.code ? e.code : ''} ${e && e.message ? e.message : e}`.slice(0, 400))
          }
        }
      }

      // 5. Assessment
      const allPassages = evidence.flatMap((e) => e.passages.map((p) => ({ ...p, url: e.url })))
      const assessmentResult = await assessClaim(claim, allPassages, opts, exec)

      // 6. Return immutable snapshot refs
      return toLosslessJson({
        claim,
        subQueries,
        assessment: assessmentResult.assessment,
        assessmentModel: assessmentResult.assessmentModel,
        assessmentGeneratedAt: assessmentResult.assessmentGeneratedAt,
        evidenceSnapshotRefs: evidence.map((e) => ({
          cacheRef: e.cacheRef,
          url: e.url,
          contentDigest: e.contentDigest,
          passages: e.passages.map((p) => ({ offset: p.offset, length: p.length, text: p.text, label: p.label })),
        })),
      })
    },
  })
}

function clampInt(v, fallback, min, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
