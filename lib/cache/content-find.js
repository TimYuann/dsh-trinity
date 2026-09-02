// lib/cache/content-find.js — content retrieval for `search_content` Tool
// (SPEC §II.5).
//
// Hard cap: **20 000 characters** (non-configurable absolute safety limit,
// SPEC §II.3.4). No `maxInlineContentChars` configuration field.
//
// Supports:
//   - offset / limit:  apply to the source content
//   - sourceIndex:     select one of entry.sources[]
//   - findText:        substring search (case-sensitive + case-insensitive)
//                      — cannot be combined with offset / limit
//   - findMode:        'exact' | 'case-insensitive'  (P2 #19: 'fuzzy' removed — not in SPEC)

export const HARD_CHAR_CAP = 20_000

const FIND_MODES = Object.freeze(['exact', 'case-insensitive'])

/**
 * @param {string} content
 * @param {{ offset?: number, limit?: number, findText?: string | string[],
 *           findMode?: 'exact' | 'case-insensitive' }} args
 * @returns {{ content: string, totalChars: number, matches?: Array<{ offset: number, length: number }> }}
 */
export function readContent(content, args = {}) {
  if (typeof content !== 'string') return { content: '', totalChars: 0 }
  const totalChars = content.length

  // findText path (mutually exclusive with offset/limit per SPEC §II.5).
  if (args.findText !== undefined && args.findText !== null) {
    if (args.offset !== undefined || args.limit !== undefined) {
      const e = new Error('findText cannot be combined with offset or limit')
      e.code = 'INVALID_INPUT'
      throw e
    }
    const findTexts = Array.isArray(args.findText) ? args.findText : [args.findText]
    const findMode = FIND_MODES.includes(args.findMode) ? args.findMode : 'exact'
    const matches = []
    let collected = ''
    for (const ft of findTexts) {
      if (typeof ft !== 'string' || ft.length === 0) continue
      const positions = findAllPositions(content, ft, findMode)
      for (const offset of positions) {
        matches.push({ offset, length: ft.length })
        const start = Math.max(0, offset - 200)
        const end = Math.min(content.length, offset + ft.length + 400)
        collected += content.slice(start, end) + '\n…\n'
      }
    }
    let out = collected
    if (out.length > HARD_CHAR_CAP) out = out.slice(0, HARD_CHAR_CAP)
    return { content: out, totalChars, matches }
  }

  let start = Math.max(0, Number(args.offset) || 0)
  let end = content.length
  if (typeof args.limit === 'number' && args.limit > 0) {
    end = Math.min(content.length, start + Math.floor(args.limit))
  }
  let slice = content.slice(start, end)
  if (slice.length > HARD_CHAR_CAP) slice = slice.slice(0, HARD_CHAR_CAP)
  return { content: slice, totalChars }
}

/**
 * @param {string} content
 * @param {string} needle
 * @param {'exact' | 'case-insensitive'} mode
 * @returns {number[]}
 */
function findAllPositions(content, needle, mode) {
  const out = []
  if (mode === 'case-insensitive') {
    const c = content.toLowerCase()
    const n = needle.toLowerCase()
    let i = 0
    while (i <= c.length - n.length) {
      const idx = c.indexOf(n, i)
      if (idx < 0) break
      out.push(idx)
      i = idx + Math.max(1, n.length)
    }
  } else {
    let i = 0
    while (i <= content.length - needle.length) {
      const idx = content.indexOf(needle, i)
      if (idx < 0) break
      out.push(idx)
      i = idx + Math.max(1, needle.length)
    }
  }
  return out
}
