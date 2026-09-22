// lib/util/decode-body.js — runtime-tolerant HTTP body decoding.
//
// WHY THIS EXISTS (2026-09-22, dsh-trinity 2.4.0):
//
//   Some DSH runtimes hand `fetch()` responses back with their HTTP
//   headers stripped AND the body still content-encoded. Observed under
//   DSH 0.1.7-alpha.1:
//
//     - POST https://api.exa.ai/search  → `status=200, headers={}` with a
//       still-gzipped body (`1f 8b 08 ...`)
//     - POST https://api.minimaxi.com/anthropic/v1/messages → `status=200,
//       headers={}` with a still-brotli'd SSE body (no magic bytes)
//
//   undici decompresses based on `content-encoding`. With that header gone
//   the encoded bytes reached `response.json()`, which threw:
//
//     SyntaxError: Unexpected token '\u001f', "\u001f..." is not valid JSON
//
//   Two failures compounded from there:
//
//     1. classifyError() has no pattern for a SyntaxError, so the real
//        provider failure was classed `unknown`.
//     2. The credential pool then walked its *empty* slots 2/3, where the
//        adapter throws MISSING_API_KEY (class `credential`), and the
//        chain reports the LAST attempt — so a perfectly valid Exa key
//        surfaced to the model as "provider exa failed: credential".
//
//   A provider read must therefore never trust `content-encoding`. It
//   reads the bytes once and decodes by MAGIC BYTES, which survive a
//   header-stripping runtime.
//
// SAFETY MODEL — two tiers, because false positives corrupt payloads:
//
//   Tier 1 (always): gzip, zstd and zlib-deflate carry strong magic
//   signatures, so they are detected and applied for every caller,
//   including binary readers.
//
//   Tier 2 (text readers only, opt-in): brotli and raw deflate have no
//   magic. They are attempted only when the caller declares the payload
//   is text (`textish`), only when the input is NOT already valid UTF-8,
//   and only when the result IS valid UTF-8. A binary body is therefore
//   never re-interpreted, and a text body is never double-decoded.
//
// This helper is a no-op on well-behaved runtimes: an already-decoded
// JSON, HTML or binary payload matches no signature and is returned
// byte-for-byte unchanged.

import * as zlib from 'node:zlib'

const GZIP_MAGIC = [0x1f, 0x8b]
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * @param {Uint8Array} bytes
 * @param {number[]} magic
 * @returns {boolean}
 */
function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false
  }
  return true
}

/**
 * zlib-wrapped deflate (RFC 1950): low nibble of CMF is 8 and the
 * two-byte header is a multiple of 31.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function looksLikeZlibDeflate(bytes) {
  if (bytes.length < 2) return false
  if ((bytes[0] & 0x0f) !== 8) return false
  return ((bytes[0] << 8) | bytes[1]) % 31 === 0
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isValidUtf8(bytes) {
  try {
    utf8Strict.decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Try one codec. Returns null when the codec rejects the input so the
 * caller can fall through to the next candidate.
 * @param {string} codec
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
function tryCodec(codec, bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    switch (codec) {
      case 'gzip': return new Uint8Array(zlib.gunzipSync(buf))
      case 'deflate': return new Uint8Array(zlib.inflateSync(buf))
      case 'deflate-raw': return new Uint8Array(zlib.inflateRawSync(buf))
      case 'br': return new Uint8Array(zlib.brotliDecompressSync(buf))
      case 'zstd':
        if (typeof zlib.zstdDecompressSync !== 'function') return null
        return new Uint8Array(zlib.zstdDecompressSync(buf))
      default: return null
    }
  } catch {
    return null
  }
}

/**
 * @param {string} [contentEncoding]
 * @returns {string[]}
 */
function declaredCodecs(contentEncoding) {
  return String(contentEncoding || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Decode a response body that may still be content-encoded.
 *
 * Never throws: if no codec accepts the payload the original bytes are
 * returned unchanged, so a caller degrades to its previous behaviour
 * rather than failing differently.
 *
 * @param {Uint8Array} bytes
 * @param {string} [contentEncoding]
 * @param {{ textish?: boolean }} [options]
 * @returns {Uint8Array}
 */
export function decodeContentBytes(bytes, contentEncoding, options = {}) {
  if (!bytes || bytes.length < 2) return bytes
  const declared = declaredCodecs(contentEncoding)

  // ---- Tier 1: signature-bearing codecs, always safe. ----
  if (startsWith(bytes, GZIP_MAGIC) || declared.includes('gzip') || declared.includes('x-gzip')) {
    const out = tryCodec('gzip', bytes)
    if (out) return out
  }
  if (startsWith(bytes, ZSTD_MAGIC) || declared.includes('zstd')) {
    const out = tryCodec('zstd', bytes)
    if (out) return out
  }
  if (looksLikeZlibDeflate(bytes) || declared.includes('deflate')) {
    const out = tryCodec('deflate', bytes)
    if (out) return out
  }

  // ---- Tier 2: signature-less codecs, text callers only. ----
  // A valid-UTF-8 payload is already decoded text: never reinterpret it.
  // A binary payload is never handed to these codecs at all.
  if (!options.textish) return bytes
  if (isValidUtf8(bytes)) return bytes

  const candidates = []
  if (declared.includes('br')) candidates.push('br')
  if (declared.includes('deflate')) candidates.push('deflate-raw')
  candidates.push('br', 'deflate-raw')

  for (const codec of candidates) {
    const out = tryCodec(codec, bytes)
    // Only accept a decode that produces real text; anything else is a
    // false positive on a binary payload.
    if (out && isValidUtf8(out)) return out
  }
  return bytes
}

/**
 * Read a fetch Response body as bytes, decoding any surviving
 * content-encoding. Signature-less codecs are not guessed here because
 * the caller may be handling binary content (PDF, images).
 *
 * @param {Response} response
 * @returns {Promise<Uint8Array>}
 */
export async function readResponseBytes(response) {
  const raw = new Uint8Array(await response.arrayBuffer())
  return decodeContentBytes(raw, headerValue(response, 'content-encoding'))
}

/**
 * Read a fetch Response body as decoded UTF-8 text.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
export async function readResponseText(response) {
  const raw = new Uint8Array(await response.arrayBuffer())
  const bytes = decodeContentBytes(raw, headerValue(response, 'content-encoding'), { textish: true })
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Read a fetch Response body as parsed JSON.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
export async function readResponseJson(response) {
  return JSON.parse(await readResponseText(response))
}

/**
 * @param {Response} response
 * @param {string} name
 * @returns {string | null}
 */
function headerValue(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return null
  return response.headers.get(name)
}
