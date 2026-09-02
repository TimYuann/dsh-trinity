// lib/util/lossless-json.js — deep-sanitize a value into strict lossless
// JSON (the DSH tool seam rejects outputs containing BigInt, undefined,
// functions, symbols, NaN, Infinity, or cycles with
// "value is not lossless JSON").
//
// v2.2: applied at every Tool output boundary (web_search_ex,
// web_doctor, source_check, search_content) and to error payloads
// (attempts[]) so provider-origin oddities can never trip the host
// validator.

const TAGGED_CIRCULAR = '<circular>'

/**
 * @param {unknown} value
 * @param {Set<unknown>} [seen]
 * @returns {unknown}
 */
export function toLosslessJson(value, seen = new Set()) {
  if (value === null || value === undefined) return value === undefined ? null : value
  const t = typeof value
  if (t === 'number') {
    if (Number.isNaN(value)) return null
    if (!Number.isFinite(value)) return null
    return value
  }
  if (t === 'bigint') {
    // BigInt has no JSON literal; emit a numeric string (lossless round-trip).
    return value.toString()
  }
  if (t === 'string' || t === 'boolean') return value
  if (t === 'function' || t === 'symbol') return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    // Error is not JSON-serializable as an object; emit safe fields.
    const out = { message: value.message || String(value), name: value.name || 'Error' }
    for (const k of Object.keys(value)) {
      if (k === 'message' || k === 'name') continue
      out[k] = toLosslessJson(value[k], seen)
    }
    return out
  }
  if (seen.has(value)) return TAGGED_CIRCULAR
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      for (const v of value) out.push(toLosslessJson(v, seen))
      return out
    }
    if (typeof value === 'object') {
      const out = {}
      for (const k of Object.keys(value)) {
        const v = value[k]
        if (v === undefined) continue
        if (typeof v === 'function' || typeof v === 'symbol') continue
        out[k] = toLosslessJson(v, seen)
      }
      return out
    }
  } finally {
    seen.delete(value)
  }
  return null
}
