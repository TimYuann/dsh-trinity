// lib/source-check/score.js — passage scoring for source_check (SPEC §II.5
// step 4). Lexical overlap with claim + sub-queries; keeps top N per page.

/**
 * @param {string} body
 * @param {string} claim
 * @param {string[]} subQueries
 * @param {number} topN
 * @returns {Array<{ offset: number, length: number, text: string, label: 'supporting' | 'contradicting' | 'neutral', score: number }>}
 */
export function scorePassages(body, claim, subQueries, topN = 3) {
  if (typeof body !== 'string' || body.length === 0) return []
  const claimTokens = tokenize(claim)
  const subTokens = (subQueries || []).flatMap((s) => tokenize(s))
  const allTokens = new Set([...claimTokens, ...subTokens])
  if (allTokens.size === 0) return []

  const passages = breakIntoPassages(body)
  const scored = passages.map((p) => {
    const tokens = tokenize(p.text)
    if (tokens.length === 0) return { ...p, score: 0, label: 'neutral' }
    const hits = tokens.filter((t) => allTokens.has(t)).length
    const score = hits / Math.max(1, tokens.length)
    return { ...p, score, label: labelFor(score, claimTokens, tokens) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, topN))
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (typeof text !== 'string') return []
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && t.length < 30)
}

/**
 * @param {string} body
 * @returns {Array<{ offset: number, length: number, text: string }>}
 */
function breakIntoPassages(body) {
  // Two passes: split on sentence boundaries (.?!), then merge short
  // sentences into 200-char windows per SPEC §II.5.
  const out = []
  let cursor = 0
  const sentenceRe = /[.!?]+(\s|$)/g
  let m
  while ((m = sentenceRe.exec(body)) !== null) {
    const end = m.index + m[0].length
    const sentence = body.slice(cursor, end).trim()
    if (sentence.length > 0) {
      out.push({ offset: cursor, length: sentence.length, text: sentence })
    }
    cursor = end
  }
  if (cursor < body.length) {
    const tail = body.slice(cursor).trim()
    if (tail.length > 0) {
      out.push({ offset: cursor, length: tail.length, text: tail })
    }
  }
  // P1 #11: SPEC §II.5 says "200-char windows". Hard cap at 200 chars
  // — no +100 slack. Each passage's `length` field MUST be <= 200.
  const TARGET = 200
  const merged = []
  let buf = ''
  let bufOffset = 0
  let bufLength = 0
  for (const p of out) {
    if (buf.length === 0) {
      buf = p.text
      bufOffset = p.offset
      bufLength = p.length
      continue
    }
    // Strict: never exceed TARGET chars. If adding the next sentence
    // would push us over, flush the current window first.
    if (bufLength + 1 + p.length <= TARGET) {
      buf += ' ' + p.text
      bufLength = buf.length
      continue
    }
    merged.push({ offset: bufOffset, length: bufLength, text: buf.trim() })
    // If the single sentence itself exceeds TARGET, emit it alone but
    // cap its length so it doesn't blow past the contract.
    if (p.length > TARGET) {
      merged.push({ offset: p.offset, length: TARGET, text: p.text.slice(0, TARGET) })
      buf = ''
      bufOffset = 0
      bufLength = 0
    } else {
      buf = p.text
      bufOffset = p.offset
      bufLength = p.length
    }
  }
  if (buf.length > 0) {
    merged.push({
      offset: bufOffset,
      length: Math.min(bufLength, TARGET),
      text: buf.trim().slice(0, TARGET),
    })
  }
  return merged
}

/**
 * @param {number} score
 * @param {string[]} claimTokens
 * @param {string[]} passageTokens
 */
function labelFor(score, claimTokens, passageTokens) {
  if (score < 0.05) return 'neutral'
  // Very crude contradiction detector: if the passage contains "not",
  // "false", "incorrect", "myth" alongside claim tokens, label contradicting.
  const lowers = new Set(passageTokens)
  const contradictMarkers = ['not', 'false', 'incorrect', 'myth', 'debunked', 'wrong', 'hoax']
  for (const m of contradictMarkers) if (lowers.has(m)) return 'contradicting'
  return 'supporting'
}
