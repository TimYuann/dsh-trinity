// lib/iso8601.js — date string normalisation (DESIGN §1.8)
//
// The pi-web-access providers (notably mmx) return dates in human formats
// like "2026-02-04 23:39:58". DSH's WebSearchSource.publishedAt contract is
// strict ISO-8601, so we convert and drop fields that cannot be parsed.
//
// Timezone policy (2026-09-12): a numeric timestamp that carries NO zone
// designator is pinned to UTC rather than handed to the platform parser.
// ECMAScript reads "2026-02-04T23:39:58" (date-and-time, no offset) in the
// HOST's local zone, which made the instant depend on the machine running
// the search: the same provider response produced 15:39:58Z on an
// Asia/Shanghai host and 23:39:58Z on a UTC one. Twenty-two provider
// modules call this function, so that ambiguity reached nearly every
// result's `publishedAt`, and it is what made CI disagree with a local
// checkout. Pinning to UTC is a deliberate, documented assumption: the
// providers send no zone, so the true zone is unknowable, and a single
// deterministic reading is worth more than a per-machine guess.

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i

/**
 * "YYYY-MM-DD HH:MM:SS[.fff][zone]" and its "T"-separated twin. Written as
 * one pattern so the space form and the ISO form cannot drift apart.
 */
const NUMERIC_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|z|[+-]\d{2}:?\d{2})?$/

/**
 * Reduce a numeric timestamp to a form `new Date` reads the same way on
 * every machine. Anything else is returned untouched for the platform
 * parser to attempt.
 *
 * @param {string} str
 * @returns {string}
 */
function normaliseNumericDatetime(str) {
  const m = NUMERIC_DATETIME.exec(str)
  if (!m) return str
  const [, date, time, fraction, zone] = m
  // A comma is a legal decimal separator in several locales and providers
  // emit it; `new Date` rejects it outright (the old code returned
  // undefined for "2026-02-04 23:39:58,123").
  const frac = fraction === undefined ? '' : `.${fraction}`
  // No designator → UTC, per the module header. An explicit designator is
  // always honoured as given.
  return `${date}T${time}${frac}${zone ?? 'Z'}`
}

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
  if (typeof input === 'number') {
    // Epoch milliseconds, matching `new Date(number)`. Stringifying instead
    // (the previous behaviour) made `new Date('0')` read as the YEAR 2000,
    // so a provider's numeric timestamp was silently mis-dated or dropped.
    if (!Number.isFinite(input)) return undefined
    const fromNumber = new Date(input)
    return Number.isFinite(fromNumber.getTime()) ? fromNumber.toISOString() : undefined
  }
  if (typeof input !== 'string') return undefined
  const str = input.trim()
  if (str.length === 0) return undefined
  // Common normalization: "YYYY-MM-DD HH:MM:SS" -> ISO-8601 by replacing the
  // space with T, with the zone pinned deterministically (see header).
  const candidate = normaliseNumericDatetime(str)
  const date = new Date(candidate)
  const t = date.getTime()
  if (!Number.isFinite(t)) return undefined
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
