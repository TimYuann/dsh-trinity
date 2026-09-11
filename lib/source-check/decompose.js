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
  const limit = Math.max(2, Math.min(6, count))
  // Preferred path: the model complied and returned a JSON array.
  const parsed = tryParseJsonArray(out)
  if (Array.isArray(parsed)) {
    const fromJson = sanitizeQueries(parsed.filter((s) => typeof s === 'string'), { lenient: true })
    if (fromJson.length >= 2) return fromJson.slice(0, limit)
  }
  // Fallback path: the model narrated. Line-splitting alone used to hand
  // its reasoning prose to scorePassages(), which then tokenized that
  // prose into the lexical overlap score (defect B). Sanitize first, and
  // fall back to heuristics when nothing query-shaped survives.
  const fromLines = sanitizeQueries(splitSubQueryLines(out))
  if (fromLines.length >= 2) return fromLines.slice(0, limit)
  return heuristicSubQueries(claim, count)
}

/**
 * Salient words a model uses when it is *describing* the task instead of
 * answering it. A line starting with one of these is narration, never a
 * search query — the observed leak opened with
 * "We need answer only JSON array of strings. Need decompose claim …".
 */
const META_PREFIXES = [
  'we need', 'we should', 'we must', 'we will', 'we can', 'we are',
  'i need', 'i will', 'i should', 'let me', 'the user', 'the claim',
  'here is', 'here are', 'these are', 'this is', 'the following',
  'sure,', 'sure:', 'okay,', 'note:', 'note that', 'first,', 'then,',
  'next,', 'finally,', 'json array', 'return only', 'output:', 'response:',
  'answer:', 'claim:', 'sub-query', 'subquery', 'sub query',
]

const MIN_QUERY_CHARS = 8
const MAX_QUERY_CHARS = 200
/** Longer than this and a line must be interrogative to count as a query. */
const PROSE_LENGTH = 120

/**
 * Pull the sub-queries a model produced out of its surrounding prose.
 *
 * Order of preference (defect B):
 *   1. quoted strings — a narrating model still quotes what it produced
 *   2. list lines — markers stripped, then shape-checked
 *
 * @param {string} out raw completion text
 * @returns {string[]}
 */
export function splitSubQueryLines(out) {
  if (typeof out !== 'string' || out.length === 0) return []
  const quoted = extractQuoted(out)
  if (quoted.length >= 2) return quoted
  return out
    .split(/\r?\n/)
    .map(stripListMarker)
    .filter((line) => line.length > 0)
  // Shape filtering happens in sanitizeQueries so both paths share it.
}

/**
 * Drop everything that is not shaped like a search query, de-duplicate,
 * and keep the original order.
 *
 * @param {string[]} candidates
 * @param {{ lenient?: boolean }} [opts] lenient = skip the "too short"
 *   rule (used for lines the model already delivered as a JSON array)
 * @returns {string[]}
 */
export function sanitizeQueries(candidates, opts = {}) {
  const lenient = opts.lenient === true
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (typeof raw !== 'string') continue
    const s = stripListMarker(raw)
    if (!isQueryShaped(s, lenient)) continue
    const dedupKey = s.toLowerCase()
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    out.push(s)
  }
  return out
}

/**
 * @param {string} line
 * @returns {string}
 */
function stripListMarker(line) {
  return String(line)
    .trim()
    .replace(/^[-*•·–—>]+\s*/, '')          // bullets
    .replace(/^\d+\s*[.)\]:]\s*/, '')       // 1. / 2) / 3:
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')  // a line wrapped in quotes
    .trim()
}

/**
 * @param {string} s
 * @param {boolean} lenient
 * @returns {boolean}
 */
function isQueryShaped(s, lenient) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (t.length === 0) return false
  if (t.length > MAX_QUERY_CHARS) return false
  if (!lenient && t.length < MIN_QUERY_CHARS) return false
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  if (/[[\]{}]/.test(t)) return false            // JSON scaffolding leaked
  if (t.endsWith(':')) return false              // a lead-in, not a query
  const lower = t.toLowerCase()
  if (META_PREFIXES.some((p) => lower.startsWith(p))) return false
  if (lower.includes('json array') || lower.includes('return only')) return false
  if (t.length > PROSE_LENGTH && !t.includes('?')) return false
  return true
}

/**
 * @param {string} out
 * @returns {string[]}
 */
function extractQuoted(out) {
  const found = []
  const re = /"([^"\n]{8,200})"|“([^”\n]{8,200})”/g
  let m
  while ((m = re.exec(out)) !== null) {
    const s = (m[1] || m[2] || '').trim()
    if (s.length > 0) found.push(s)
  }
  return found
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
