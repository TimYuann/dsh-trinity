// test/ssrf.test.js — SSRF validator + DNS preflight (SPEC §4.3 / §4.9)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRemoteUrl,
  isBlockedIPv4,
  isBlockedIPv6,
  parseCidr,
  normalizeHostname,
} from '../lib/providers/fetch/ssrf.js'

test('normalizeHostname lower-cases + trims dot + strips brackets', () => {
  assert.equal(normalizeHostname('Example.COM'), 'example.com')
  assert.equal(normalizeHostname('foo.example.com.'), 'foo.example.com')
  assert.equal(normalizeHostname('[::1]'), '::1')
})

test('parseCidr accepts IPv4 + IPv6 and rejects garbage', () => {
  assert.deepEqual(parseCidr('10.0.0.0/8'), { network: '10.0.0.0', prefix: 8, family: 4 })
  assert.deepEqual(parseCidr('fc00::/7'), { network: 'fc00::', prefix: 7, family: 6 })
  assert.throws(() => parseCidr('garbage'))
  assert.throws(() => parseCidr('10.0.0.0/33'))
})

test('isBlockedIPv4 catches every private / reserved range', () => {
  for (const ip of ['0.0.0.5', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254',
                    '172.16.0.1', '172.31.255.1', '192.168.1.1', '198.18.0.1',
                    '224.0.0.1', '239.255.255.255']) {
    assert.equal(isBlockedIPv4(ip, []), true, ip)
  }
  assert.equal(isBlockedIPv4('8.8.8.8', []), false)
})

test('isBlockedIPv4 honours allowRanges', () => {
  // 198.18.0.0/15 default blocked; allow via allowRanges
  assert.equal(isBlockedIPv4('198.18.0.1', []), true)
  assert.equal(isBlockedIPv4('198.18.0.1', ['198.18.0.0/15']), false)
  // allowRanges does not bypass 127/8 etc
  assert.equal(isBlockedIPv4('127.0.0.1', ['198.18.0.0/15']), true)
})

test('isBlockedIPv6 catches ::1, fc00::/7, fe80::/10', () => {
  assert.equal(isBlockedIPv6('::1', []), true)
  assert.equal(isBlockedIPv6('fc00::1', []), true)
  assert.equal(isBlockedIPv6('fe80::1', []), true)
  assert.equal(isBlockedIPv6('2001:db8::1', []), false)
})

test('isBlockedIPv6 maps IPv4-mapped IPv6 to IPv4 blacklist', () => {
  assert.equal(isBlockedIPv6('::ffff:127.0.0.1', []), true)
  assert.equal(isBlockedIPv6('::ffff:8.8.8.8', []), false)
})

test('validateRemoteUrl: protocol allowlist', async () => {
  await assert.rejects(
    validateRemoteUrl('file:///etc/passwd', { ssrf: { allowRanges: [], trustEnvProxy: false } }),
    (e) => e.code === 'WEB_BLOCKED_URL' && /Only HTTP/.test(e),
  )
  await assert.rejects(
    validateRemoteUrl('ftp://example.com', { ssrf: { allowRanges: [], trustEnvProxy: false } }),
    (e) => e.code === 'WEB_BLOCKED_URL',
  )
})

test('validateRemoteUrl: localhost / loopback blocked', async () => {
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://foo.localhost/']) {
    await assert.rejects(
      validateRemoteUrl(u, { ssrf: { allowRanges: [], trustEnvProxy: false } }),
      (e) => e.code === 'WEB_BLOCKED_URL',
      u,
    )
  }
})

test('validateRemoteUrl: domain policy allow', async () => {
  await assert.rejects(
    validateRemoteUrl('https://api.example.com', {
      ssrf: { allowRanges: [], trustEnvProxy: true },  // skip DNS
      domainPolicy: { allow: ['only-this.com'], deny: [] },
    }),
    (e) => e.code === 'WEB_BLOCKED_URL' && /allow list/.test(e),
  )
})

test('validateRemoteUrl: domain policy deny', async () => {
  await assert.rejects(
    validateRemoteUrl('https://evil.example.com', {
      ssrf: { allowRanges: [], trustEnvProxy: true },
      domainPolicy: { allow: [], deny: ['evil.example.com'] },
    }),
    (e) => e.code === 'WEB_BLOCKED_URL' && /deny/.test(e),
  )
})

test('validateRemoteUrl: hint for 198.18.0.0/15', async () => {
  await assert.rejects(
    validateRemoteUrl('http://198.18.0.1', { ssrf: { allowRanges: [], trustEnvProxy: false } }),
    (e) => /configure ssrf\.allowRanges/.test(e.message),
  )
})

test('validateRemoteUrl: trustEnvProxy=true skips DNS lookup', async () => {
  // trustEnvProxy=true should NOT reject for IP private addresses without allowRanges
  // BUT it should still reject hostname=localhost / .localhost
  await assert.rejects(
    validateRemoteUrl('http://localhost/', { ssrf: { allowRanges: [], trustEnvProxy: true } }),
    (e) => e.code === 'WEB_BLOCKED_URL',
  )
  // public hostnames should pass DNS skip
  const u = await validateRemoteUrl('https://example.com/', { ssrf: { allowRanges: [], trustEnvProxy: true } })
  assert.equal(u.toString(), 'https://example.com/')
})