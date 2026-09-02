// lib/source-check/decompose.js — claim → sub-queries via the DSH llm
// seam (SPEC §II.5 source_check step 1).
//
// We run a one-shot completion (lib/llm-call.js) with the claim and
// expect a JSON array of 2..4 sub-queries back. The request carries no
// tools, which prevents recursion.

import { oneShotCompletion } from '../llm-call.js'

/**
 * @param {string} claim
 * @param {number} count
 * @param {{ ctx: any, settings?: any }} opts
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<string[]>}
 */
export async function decomposeClaim(claim, count, opts, exec) {
  const ctx = opts && opts.ctx
  if (!ctx || typeof ctx.get !== 'function') {
    // Fall back to heuristics when LLM is unavailable.
    return heuristicSubQueries(claim, count)
  }
  const prompt = `Decompose the following claim into ${count} sub-queries that would either support or contradict it. Return ONLY a JSON array of strings, no other text.\n\nClaim: ${claim}`
  const out = await oneShotCompletion(ctx, { prompt, tools: [] }, exec)
  if (out === null) return heuristicSubQueries(claim, count)
  // Try to parse JSON array; otherwise split lines.
  const parsed = tryParseJsonArray(out)
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed.slice(0, Math.max(2, Math.min(6, count)))
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, Math.max(2, Math.min(6, count)))
}

/**
 * @param {string} s
 * @returns {unknown[] | null}
 */
function tryParseJsonArray(s) {
  if (typeof s !== 'string') return null
  // Find the first '[' and the last ']' and parse that span.
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Heuristic fallback when ctx.llm is unavailable.
 *
 * @param {string} claim
 * @param {number} count
 */
function heuristicSubQueries(claim, count) {
  const n = Math.max(2, Math.min(6, count))
  const out = [
    `${claim} evidence`,
    `${claim} source`,
    `${claim} criticism`,
    `${claim} research`,
  ]
  return out.slice(0, n)
}
