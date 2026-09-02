// lib/iso8601.js — date string normalisation (DESIGN §1.8)
//
// The pi-web-access providers (notably mmx) return dates in human formats
// like "2026-02-04 23:39:58". DSH's WebSearchSource.publishedAt contract is
// strict ISO-8601, so we convert and drop fields that cannot be parsed.

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i

/**
 * Parse arbitrary date-ish input and return an ISO-8601 string, or undefined
 * when the input cannot be losslessly represented as a Date.
 *
 * @param {unknown} input
 * @returns {string | undefined}
 */
export function toIso8601(input) {
  if (input == null) return undefined
  if (input instanceof Date) {
    const t = input.getTime()
    return Number.isFinite(t) ? input.toISOString() : undefined
  }
  if (typeof input !== 'string' && typeof input !== 'number') return undefined
  const str = String(input).trim()
  if (str.length === 0) return undefined
  // Common normalization: "YYYY-MM-DD HH:MM:SS" -> ISO-8601 by replacing the space with T.
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(str)
    ? str.replace(' ', 'T')
    : str
  const date = new Date(candidate)
  const t = date.getTime()
  if (!Number.isFinite(t)) return undefined
  // Guard against silent timezone shifts when input is ambiguous.
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

/**
 * Strictly check whether a value already matches the ISO-8601 prefix DSH
 * expects. Rejects "YYYY-MM-DD HH:MM:SS" with a space.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidIso8601(value) {
  if (typeof value !== 'string') return false
  return ISO8601_PATTERN.test(value)
}