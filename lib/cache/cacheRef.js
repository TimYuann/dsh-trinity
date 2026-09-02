// lib/cache/cacheRef.js — ULID cacheRef generator (SPEC §II.3.4).
//
// High-entropy identifier with the literal prefix `wac_` (web access
// chain). Format: 10 chars of timestamp (ms) + 16 chars of randomness,
// Crockford base32 alphabet (no I/L/O/U to avoid OCR ambiguity).
//
// NOT monotonic — we don't need sortability. Two cacheRef values produced
// in the same millisecond are guaranteed unique by their random halves.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * @param {number} [now]
 * @returns {string}
 */
export function makeCacheRef(now = Date.now()) {
  const tsPart = encodeTime(now)
  const randPart = encodeRandom()
  return 'wac_' + tsPart + randPart
}

/**
 * @param {number} now
 * @returns {string}  10 chars
 */
function encodeTime(now) {
  let out = ''
  let n = now
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

/**
 * 16 chars of cryptographically-strong randomness.
 *
 * P2 #18: SPEC §II.3.4 mandates "high-entropy cacheRef". We refuse to
 * silently degrade to Math.random() — the previous fallback left the
 * cacheRef weakly guessable when globalThis.crypto is absent. Node 18+
 * always exposes globalThis.crypto.getRandomValues; if not, we throw
 * loudly so the deployment can be diagnosed instead of producing
 * silently-broken cacheRefs.
 */
function encodeRandom() {
  const bytes = new Uint8Array(10)
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('cacheRef requires globalThis.crypto.getRandomValues; node:crypto unavailable')
  }
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    out += ALPHABET[b % 32]
  }
  // Pad to exactly 16 chars
  while (out.length < 16) out += ALPHABET[0]
  return out.slice(0, 16)
}

/**
 * Decode a cacheRef timestamp to ms epoch. Useful for debugging; not part
 * of the contract.
 *
 * @param {string} cacheRef
 * @returns {number | null}
 */
export function decodeCacheRefTime(cacheRef) {
  if (typeof cacheRef !== 'string' || !cacheRef.startsWith('wac_')) return null
  const body = cacheRef.slice(4, 14)
  let n = 0
  for (const c of body) {
    const idx = ALPHABET.indexOf(c)
    if (idx < 0) return null
    n = n * 32 + idx
  }
  return n
}
