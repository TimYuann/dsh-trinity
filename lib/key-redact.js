// lib/key-redact.js — secret scrubbing helpers (DESIGN §1.24)
//
// Every error path, log call, and content return must redact credential
// material before it leaves the process. The simple split+join approach is
// intentionally conservative — it cannot fail on edge inputs the way a regex
// escape would.

/**
 * Replace every occurrence of `key` inside `text` with the literal "[redacted]".
 * Returns text unchanged when either argument is not a non-empty string.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function redactCredential(text, key) {
  if (typeof text !== 'string') return text
  if (typeof key !== 'string' || key.length === 0) return text
  if (!text.includes(key)) return text
  return text.split(key).join('[redacted]')
}

/**
 * Apply redactCredential once per key. Deduplicates and filters to non-empty
 * strings. Returns the original text untouched when no keys are supplied.
 *
 * @param {string} text
 * @param {string[]} keys
 * @returns {string}
 */
export function redactAllCredentials(text, keys) {
  if (typeof text !== 'string') return text
  if (!Array.isArray(keys) || keys.length === 0) return text
  const seen = new Set()
  let out = text
  for (const raw of keys) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out = redactCredential(out, raw)
  }
  return out
}

/**
 * Produce a shallow Error/AbortError clone whose `.message` has been redacted.
 * Preserves `.code`, `.name`, and prototype so the original class is still
 * recognised by the web seam.
 *
 * @param {unknown} err
 * @param {string[]} keys
 * @returns {unknown}
 */
export function redactError(err, keys) {
  if (!err || typeof err !== 'object') return err
  const proto = Object.getPrototypeOf(err)
  const cloned = Object.create(proto)
  for (const key of Object.getOwnPropertyNames(err)) {
    try {
      const value = err[key]
      if (key === 'message' && typeof value === 'string') {
        cloned[key] = redactAllCredentials(value, keys)
      } else {
        cloned[key] = value
      }
    } catch {
      // skip non-cloneable fields
    }
  }
  return cloned
}