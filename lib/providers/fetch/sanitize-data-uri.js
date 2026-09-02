// lib/providers/fetch/sanitize-data-uri.js — RFC 2397 data: URI sanitiser
// (R3 P3 #25 split-out).
//
// Replaces inline `data:` URIs with bounded omission markers. Records
// metadata (MIME, encoding, bytes, sha256) so the model knows what was
// dropped without re-fetching. R3 P0 #8: unsafe mediatypes (text/html,
// image/svg+xml, application/javascript, …) are ALWAYS omitted, regardless
// of payload size — these are scriptable and XSS-vulnerable.

import { createHash } from 'node:crypto'

const DATA_URI_RE = /data:([a-zA-Z0-9!#$&^_\-+.]{1,128}\/[a-zA-Z0-9!#$&^_\-+.]{1,128})(;[a-zA-Z0-9!#$&^_\-+.]+=[a-zA-Z0-9!#$&^_\-+./]+)*(;base64)?,([\s\S]*?)(?=[\s"'<>)\]}>,]|$)/g

const MAX_KEEP_BYTES = 4096

const UNSAFE_MEDIATYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
])

/**
 * @param {string} text
 * @returns {{ text: string, replaced: number, totalBytesRemoved: number }}
 */
export function sanitizeDataUris(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text || '', replaced: 0, totalBytesRemoved: 0 }
  }
  let replaced = 0
  let totalBytesRemoved = 0
  const out = text.replace(DATA_URI_RE, (match, mediatype, _params, base64Flag, payload) => {
    replaced++
    const isBase64 = typeof base64Flag === 'string' && base64Flag.toLowerCase() === ';base64'
    const bytes = isBase64 ? Buffer.from(payload, 'base64').byteLength : Buffer.byteLength(payload, 'utf8')
    totalBytesRemoved += bytes
    const sha256 = isBase64
      ? createHash('sha256').update(Buffer.from(payload, 'base64')).digest('hex').slice(0, 16)
      : createHash('sha256').update(payload).digest('hex').slice(0, 16)
    const encoding = isBase64 ? 'base64' : 'percent-encoded-or-text'
    const mtLower = String(mediatype || '').toLowerCase()
    if (UNSAFE_MEDIATYPES.has(mtLower)) {
      return `[data-uri refused: mediatype=${mediatype}, reason=unsafe-mediatype, encoding=${encoding}, bytes=${bytes}, sha256=${sha256}, retrieval=not-retained]`
    }
    if (bytes > MAX_KEEP_BYTES) {
      return `[data-uri omitted: mediatype=${mediatype}, encoding=${encoding}, bytes=${bytes}, sha256=${sha256}, retrieval=not-retained]`
    }
    return `[data-uri kept: mediatype=${mediatype}, encoding=${encoding}, bytes=${bytes}, sha256=${sha256}] ${payload.slice(0, MAX_KEEP_BYTES)}`
  })
  return { text: out, replaced, totalBytesRemoved }
}