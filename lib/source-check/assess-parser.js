// lib/source-check/assess-parser.js — strict assessment parser
// (v2.3.0 § Commit 5.2).
//
// The previous parser used a substring match: `norm.includes('supported')
// && !norm.includes('contradicted')`. That meant a verbatim "unsupported"
// or "not supported" verdict surfaced as `supported`.
//
// The replacement expects the LLM to reply with a JSON object on a single
// line:
//   {"assessment":"supported"}
// where the value is exactly one of `supported`, `contradicted`,
// `mixed`, `insufficient`. Anything else falls through to a
// deterministic fallback (heuristicAssess over the supplied passages)
// without paying for a second paid LLM call.

const ALLOWED = new Set(['supported', 'contradicted', 'mixed', 'insufficient'])

/**
 * Parse a single LLM reply line. Returns `{ assessment, ok }`.
 *
 * @param {unknown} raw
 * @returns {{ assessment: 'supported' | 'contradicted' | 'mixed' | 'insufficient', ok: boolean }}
 */
export function parseAssessment(raw) {
  if (typeof raw !== 'string') {
    return { assessment: 'insufficient', ok: false }
  }
  const text = raw.trim()
  // Allow leading code-fence markers or prose around the JSON; the
  // parser only succeeds when an exact-match JSON object is present.
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return { assessment: 'insufficient', ok: false }
  }
  const candidate = text.slice(jsonStart, jsonEnd + 1)
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { assessment: 'insufficient', ok: false }
  }
  if (!parsed || typeof parsed !== 'object') return { assessment: 'insufficient', ok: false }
  const v = parsed.assessment
  if (typeof v !== 'string') return { assessment: 'insufficient', ok: false }
  if (!ALLOWED.has(v)) return { assessment: 'insufficient', ok: false }
  return { assessment: v, ok: true }
}

export const ASSESSMENT_VALUES = Array.from(ALLOWED)
