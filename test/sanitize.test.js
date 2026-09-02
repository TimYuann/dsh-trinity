// test/sanitize.test.js — data: URI sanitiser + HTML sanitiser (Commit 3).
//
// Per SPEC §II.7: inline `data:` URIs must be replaced with bounded
// omission markers (MIME / encoding / bytes / SHA-256 /
// `retrieval=not-retained`) so unbounded base64 payloads do not land
// in the cache.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDataUris, sanitizeHtml, sanitizeForCache } from '../lib/providers/fetch/sanitize.js'

test('sanitizeDataUris: small base64 data: URI is kept (≤ 4 KiB)', () => {
  // Tiny PNG-like payload, 100 bytes raw → base64 ≈ 136 chars.
  const raw = Buffer.alloc(100, 0x42)
  const payload = raw.toString('base64')
  const text = `before <img src="data:image/png;base64,${payload}" /> after`
  const r = sanitizeDataUris(text)
  assert.equal(r.replaced, 1)
  assert.ok(r.text.includes('data-uri kept'))
  assert.ok(r.text.includes('mediatype=image/png'))
  assert.ok(r.text.includes('encoding=base64'))
  assert.ok(r.text.includes('bytes=100'))
  assert.ok(r.text.includes('sha256='))
})

test('sanitizeDataUris: large base64 data: URI is omitted (> 4 KiB)', () => {
  // 8 KiB raw → base64 ≈ 11 KiB chars.
  const raw = Buffer.alloc(8 * 1024, 0x42)
  const payload = raw.toString('base64')
  const text = `<img src="data:image/png;base64,${payload}" />`
  const r = sanitizeDataUris(text)
  assert.equal(r.replaced, 1)
  assert.ok(r.text.includes('data-uri omitted'))
  assert.ok(r.text.includes('retrieval=not-retained'))
  assert.ok(r.text.includes('mediatype=image/png'))
  assert.ok(r.text.includes('bytes=8192'))
  // The original base64 must NOT be in the output.
  assert.equal(r.text.includes(payload.slice(0, 200)), false)
})

test('sanitizeDataUris: multiple data: URIs in one string are all replaced', () => {
  const text = `data:text/plain,hello data:text/html,world`
  const r = sanitizeDataUris(text)
  assert.equal(r.replaced, 2)
})

test('sanitizeDataUris: text/plain data: URI is percent-or-text encoding', () => {
  const text = `data:text/plain,hello%20world`
  const r = sanitizeDataUris(text)
  assert.equal(r.replaced, 1)
  assert.ok(r.text.includes('encoding=percent-encoded-or-text'))
})

test('sanitizeDataUris: empty input is a no-op', () => {
  const r = sanitizeDataUris('')
  assert.equal(r.replaced, 0)
  assert.equal(r.totalBytesRemoved, 0)
})

test('sanitizeDataUris: input without data: URIs is unchanged', () => {
  const text = 'plain text without any data: URIs at all'
  const r = sanitizeDataUris(text)
  assert.equal(r.replaced, 0)
  assert.equal(r.text, text)
})

test('sanitizeHtml: strips <script> blocks', () => {
  const html = '<p>before</p><script>alert(1)</script><p>after</p>'
  const out = sanitizeHtml(html)
  assert.ok(!out.includes('<script'))
  assert.ok(!out.includes('alert(1)'))
  assert.ok(out.includes('before'))
  assert.ok(out.includes('after'))
})

test('sanitizeHtml: strips inline event handlers (onclick="...")', () => {
  const html = '<p onclick="evil()">click me</p>'
  const out = sanitizeHtml(html)
  assert.ok(!out.includes('onclick'))
  assert.ok(!out.includes('evil()'))
})

test('sanitizeForCache: combined HTML + data: pipeline', () => {
  const raw = Buffer.alloc(8 * 1024, 0x42)
  const payload = raw.toString('base64')
  const html = `<html><body><p>hello</p><script>bad()</script><img src="data:image/png;base64,${payload}" /></body></html>`
  const r = sanitizeForCache(html)
  assert.ok(!r.text.includes('<script'))
  assert.ok(!r.text.includes('bad()'))
  assert.ok(r.text.includes('data-uri omitted'))
  assert.equal(r.data.replaced, 1)
})
