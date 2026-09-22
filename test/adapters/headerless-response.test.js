// test/adapters/headerless-response.test.js — header-stripping runtime
// tolerance (2026-09-22, DSH 0.1.7-alpha.1).
//
// The runtime delivers `status=200` responses with NO headers at all and
// the body still content-encoded. Two consequences for web_fetch:
//
//   1. `content-type` is empty, so classifyContentType() fell through to
//      `binary` and https://example.com/ was rejected with
//      UNSUPPORTED_CONTENT_TYPE ("unsupported content type: ").
//   2. The body was still gzip/brotli, so any parse of it produced
//      garbage.
//
// Fixes: sniff the decoded bytes when the declared type is absent, and
// decode surviving content-encodings before dispatch
// (lib/util/decode-body.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zlib from 'node:zlib'

import { classifyContentType, sniffContentKind } from '../../lib/providers/fetch/chained-fetch.js'

const HTML = '<!DOCTYPE html><html><body><p>hello world</p></body></html>'
const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'))

const FETCH_OPTIONS = {
  ssrf: { allowRanges: [], trustEnvProxy: false },
  domainPolicy: { allow: [], deny: [] },
  maxBytes: 5 * 1024 * 1024,
}

test('an absent content-type is sniffed from the bytes', () => {
  assert.equal(classifyContentType('', bytes(HTML)), 'html')
  assert.equal(classifyContentType('', bytes('%PDF-1.7\n...')), 'pdf')
  assert.equal(classifyContentType('', bytes('{"a":1}')), 'text')
  assert.equal(classifyContentType('', bytes('[1,2,3]')), 'text')
  assert.equal(classifyContentType('', bytes('<?xml version="1.0"?><rss><channel/></rss>')), 'rss')
  assert.equal(classifyContentType('', bytes('<?xml version="1.0"?><root/>')), 'text')
  assert.equal(classifyContentType('', bytes('  \uFEFF<!doctype html><html></html>')), 'html')
})

test('sniffing never invents a kind for real binary', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  assert.equal(classifyContentType('', png), 'binary')
  assert.equal(sniffContentKind(png), null)
  // Too short to judge.
  assert.equal(sniffContentKind(new Uint8Array([0x3c])), null)
  assert.equal(sniffContentKind(undefined), null)
  // No declared type and no bytes still behaves exactly as before.
  assert.equal(classifyContentType(''), 'binary')
})

test('a declared content-type is always believed over sniffing', () => {
  // Servers that DO send a header must not be second-guessed.
  assert.equal(classifyContentType('application/octet-stream', bytes(HTML)), 'archive')
  assert.equal(classifyContentType('image/png', bytes(HTML)), 'image')
  assert.equal(classifyContentType('application/pdf', bytes(HTML)), 'pdf')
})

test('REGRESSION: a headerless HTML response now fetches instead of throwing', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from(HTML, 'utf8'), { status: 200 })
  try {
    const { chainedFetch } = await import('../../lib/providers/fetch/chained-fetch.js')
    const r = await chainedFetch({ url: 'https://example.com/' }, undefined, FETCH_OPTIONS)
    assert.equal(r.adapterId, 'genericHtml')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('REGRESSION: a headerless gzip HTML response is decoded before dispatch', async () => {
  const origFetch = globalThis.fetch
  const gz = zlib.gzipSync(Buffer.from(HTML, 'utf8'))
  globalThis.fetch = async () => new Response(gz, { status: 200 })
  try {
    const { chainedFetch } = await import('../../lib/providers/fetch/chained-fetch.js')
    const r = await chainedFetch({ url: 'https://example.com/' }, undefined, FETCH_OPTIONS)
    assert.equal(r.adapterId, 'genericHtml')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('REGRESSION: a headerless brotli HTML response is decoded before dispatch', async () => {
  // This is the shape that actually reached the host: no content-type AND
  // no content-encoding, with a brotli body (brotli has no magic bytes, so
  // only the text-only recovery path can identify it).
  const origFetch = globalThis.fetch
  const br = zlib.brotliCompressSync(Buffer.from(HTML, 'utf8'))
  globalThis.fetch = async () => new Response(br, { status: 200 })
  try {
    const { chainedFetch } = await import('../../lib/providers/fetch/chained-fetch.js')
    const r = await chainedFetch({ url: 'https://example.com/' }, undefined, FETCH_OPTIONS)
    assert.equal(r.adapterId, 'genericHtml')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('headerless binary is still refused, never decoded into text', async () => {
  const origFetch = globalThis.fetch
  // PNG magic + incompressible tail: neither brotli nor raw deflate accepts it.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 137) % 256)),
  ])
  globalThis.fetch = async () => new Response(png, { status: 200 })
  try {
    const { chainedFetch } = await import('../../lib/providers/fetch/chained-fetch.js')
    let caught
    try {
      await chainedFetch({ url: 'https://example.com/image' }, undefined, FETCH_OPTIONS)
    } catch (e) { caught = e }
    assert.equal(caught && caught.code, 'UNSUPPORTED_CONTENT_TYPE')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('REGRESSION: a headerless gzip PDF response still routes to the PDF adapter', async () => {
  const origFetch = globalThis.fetch
  const gz = zlib.gzipSync(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'binary'))
  globalThis.fetch = async () => new Response(gz, { status: 200 })
  try {
    const { chainedFetch } = await import('../../lib/providers/fetch/chained-fetch.js')
    let caught
    try {
      await chainedFetch({ url: 'https://example.com/file' }, undefined, FETCH_OPTIONS)
    } catch (e) { caught = e }
    // Routing is the contract, not parsing: a 12-byte "PDF" cannot parse,
    // so the failure must come from the PDF adapter, never from
    // UNSUPPORTED_CONTENT_TYPE.
    assert.notEqual(caught && caught.code, 'UNSUPPORTED_CONTENT_TYPE')
  } finally {
    globalThis.fetch = origFetch
  }
})
