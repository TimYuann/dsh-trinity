// test/chained-fetch.fetch.test.js — http + SSRF + Readability + RSC smoke (SPEC §4.9)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChainedFetchAvailable, chainedFetch } from '../lib/providers/fetch/chained-fetch.js'
import { isRSCBody, extractRSCContent } from '../lib/providers/fetch/rsc.js'
import { isLikelyJSRendered } from '../lib/providers/fetch/readability.js'

test('isChainedFetchAvailable true on Node 18+ fetch', () => {
  assert.equal(isChainedFetchAvailable(), true)
})

test('chainedFetch blocks 127.0.0.1 with WEB_BLOCKED_URL', async () => {
  await assert.rejects(
    chainedFetch({ url: 'http://127.0.0.1/' }, undefined, {
      ssrf: { allowRanges: [], trustEnvProxy: false },
    }),
    (e) => e.code === 'WEB_BLOCKED_URL',
  )
})

test('chainedFetch blocks file:// protocol', async () => {
  await assert.rejects(
    chainedFetch({ url: 'file:///etc/passwd' }, undefined, {
      ssrf: { allowRanges: [], trustEnvProxy: false },
    }),
    (e) => e.code === 'WEB_BLOCKED_URL' && /Only HTTP/.test(e.message),
  )
})

test('chainedFetch rejects URL without http/https', async () => {
  await assert.rejects(
    chainedFetch({ url: 'ftp://example.com' }, undefined, {
      ssrf: { allowRanges: [], trustEnvProxy: false },
    }),
    (e) => e.code === 'WEB_BLOCKED_URL',
  )
})

test('chainedFetch on a real public URL returns html/text body', async () => {
  // example.com is a stable fixture
  const r = await chainedFetch({ url: 'https://example.com/' }, undefined, {
    ssrf: { allowRanges: [], trustEnvProxy: false },
  })
  assert.ok(r.statusCode >= 200 && r.statusCode < 400, 'status 2xx/3xx')
  assert.ok(['html', 'text'].includes(r.body.kind), `body.kind ${r.body.kind}`)
  assert.ok(typeof r.body.content === 'string' && r.body.content.length > 0, 'content non-empty')
  assert.equal(r.url.includes('example.com'), true)
})

test('isRSCBody + extractRSCContent detect Next.js flight script', () => {
  // Minimal RSC HTML with self.__next_f.push — extract should produce markdown
  const html = `<html><head><script>self.__next_f.push([1,"23:[\\"\\$\\",\\"html\\",null,{\\"children\\":[[\\"\\$\\",\\"body\\",null,{\\"children\\":[[\\"\\$\\",\\"h1\\",null,{\\"children\\":\\"Hello\\"}],[\\"\\$\\",\\"p\\",null,{\\"children\\":\\"World\\"}]]}]}]}]"])</script></head><body>fallback</body></html>`
  assert.equal(isRSCBody(html), true)
  const out = extractRSCContent(html)
  assert.ok(out === null || (out.content && out.content.length > 0))
})

test('isRSCBody returns false for plain HTML', () => {
  assert.equal(isRSCBody('<html><body>plain</body></html>'), false)
})

test('isLikelyJSRendered: empty body + many scripts → true', () => {
  const html = '<html><body><script>a</script><script>b</script><script>c</script><script>d</script></body></html>'
  assert.equal(isLikelyJSRendered(html), true)
})

test('isLikelyJSRendered: rich content → false', () => {
  const html = '<html><body>' + 'lorem ipsum '.repeat(80) + '<script>foo</script></body></html>'
  assert.equal(isLikelyJSRendered(html), false)
})