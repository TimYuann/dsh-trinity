// test/decode-body.test.js — runtime-tolerant body decoding
// (lib/util/decode-body.js).
//
// REGRESSION (2026-09-22, DSH 0.1.7-alpha.1):
//   A POST to https://api.exa.ai/search came back `status=200,
//   headers={}` with the body still gzip frames. `response.json()`
//   threw `SyntaxError: Unexpected token '\u001f'`, classifyError()
//   could not pattern-match a SyntaxError (class `unknown`), the pool
//   walked its empty slots 2/3 (MISSING_API_KEY → class `credential`),
//   and the chain reported the LAST attempt — so a valid Exa key was
//   reported to the model as "provider exa failed: credential".
//
// The first test below is the RED proof that the platform read fails and
// the GREEN proof that the helper succeeds on the very same Response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zlib from 'node:zlib'

import {
  decodeContentBytes,
  readResponseBytes,
  readResponseText,
  readResponseJson,
} from '../lib/util/decode-body.js'

const PAYLOAD = JSON.stringify({
  requestId: 'abc',
  results: [{ id: 'https://www.iana.org/help/example-domains', title: 'Example Domains' }],
})

/**
 * Build the exact broken-runtime Response: compressed body, no
 * `content-encoding` header at all.
 * @param {Buffer} body
 */
function headerlessResponse(body) {
  return new Response(body, { status: 200 })
}

test('REGRESSION: headerless gzip body defeats response.json() but not readResponseJson()', async () => {
  const gz = zlib.gzipSync(Buffer.from(PAYLOAD, 'utf8'))

  // RED — the platform read is what actually failed in production.
  await assert.rejects(
    () => headerlessResponse(gz).json(),
    (err) => err instanceof SyntaxError,
    'plain response.json() must fail on an undecoded gzip body',
  )

  // GREEN — the helper decodes by magic bytes with no header to help it.
  const parsed = await readResponseJson(headerlessResponse(gz))
  assert.equal(parsed.requestId, 'abc')
  assert.equal(parsed.results[0].title, 'Example Domains')
})

test('decodes gzip, zlib-deflate and raw-deflate bodies with no header at all', async () => {
  const raw = Buffer.from(PAYLOAD, 'utf8')
  const cases = [
    ['gzip', zlib.gzipSync(raw)],
    ['deflate', zlib.deflateSync(raw)],
  ]
  for (const [name, body] of cases) {
    const text = await readResponseText(headerlessResponse(body))
    assert.equal(text, PAYLOAD, `${name} should decode without a header`)
  }
})

test('recovers headerless brotli for text readers (the MiniMax shape)', async () => {
  // Brotli has no magic bytes: the SSE stream from api.minimaxi.com came
  // back headerless and brotli-compressed. Only a text reader may guess.
  const raw = Buffer.from(PAYLOAD, 'utf8')
  const br = zlib.brotliCompressSync(raw)
  assert.equal(await readResponseText(headerlessResponse(br)), PAYLOAD)
})

test('never guesses a signature-less codec for byte readers (binary safety)', async () => {
  const raw = Buffer.from(PAYLOAD, 'utf8')
  const br = zlib.brotliCompressSync(raw)
  // A byte reader may be holding a PDF or an image: returning it
  // unchanged is correct, mis-decoding it would corrupt the payload.
  assert.deepEqual(await readResponseBytes(headerlessResponse(br)), new Uint8Array(br))
  // Raw deflate is likewise refused when the caller declares binary.
  const df = zlib.deflateRawSync(raw)
  assert.deepEqual(decodeContentBytes(new Uint8Array(df)), new Uint8Array(df))
})

test('never reinterprets a payload that is already valid UTF-8', async () => {
  // Guards against double-decoding and against false positives on text.
  const res = headerlessResponse(Buffer.from(PAYLOAD, 'utf8'))
  assert.equal(await readResponseText(res), PAYLOAD)
})

test('decodes zstd when the runtime provides it', async () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const body = zlib.zstdCompressSync(Buffer.from(PAYLOAD, 'utf8'))
  assert.equal(await readResponseText(headerlessResponse(body)), PAYLOAD)
})

test('honours a declared content-encoding when there is no magic', async () => {
  const raw = Buffer.from('<html><body>hi</body></html>', 'utf8')
  const br = zlib.brotliCompressSync(raw)
  const res = new Response(br, { status: 200, headers: { 'content-encoding': 'br' } })
  assert.equal(await readResponseText(res), '<html><body>hi</body></html>')
})

test('leaves uncompressed payloads byte-for-byte unchanged', async () => {
  for (const body of [PAYLOAD, '', '<html></html>', '\u0000\u0001binary-ish']) {
    const bytes = new Uint8Array(Buffer.from(body, 'utf8'))
    assert.deepEqual(decodeContentBytes(bytes), bytes)
  }
})

test('a well-behaved runtime (content-encoding present) is a no-op', async () => {
  // undici already decoded the body; the helper must not double-decode.
  const res = new Response(PAYLOAD, { status: 200, headers: { 'content-encoding': 'gzip' } })
  assert.equal(await readResponseText(res), PAYLOAD)
})

test('corrupt compressed input returns the original bytes instead of throwing', async () => {
  const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not really gzip')])
  const out = decodeContentBytes(new Uint8Array(corrupt))
  assert.deepEqual(out, new Uint8Array(corrupt))
  await assert.rejects(() => readResponseJson(headerlessResponse(corrupt)))
})

test('readResponseBytes returns decoded bytes, not the compressed frames', async () => {
  const gz = zlib.gzipSync(Buffer.from(PAYLOAD, 'utf8'))
  const bytes = await readResponseBytes(headerlessResponse(gz))
  assert.equal(new TextDecoder().decode(bytes), PAYLOAD)
  // The raw frames really did start with the gzip magic.
  assert.equal(gz[0], 0x1f)
  assert.equal(gz[1], 0x8b)
})
