// test/providers/fetch/url-policy.test.js — cross-Origin credential
// stripping (SPEC §II.7, acceptance #6).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripCredentialsOnCrossOrigin, originKey, authHeadersFor } from '../../../lib/providers/fetch/url-policy.js'

test('stripCredentialsOnCrossOrigin: no profile → headers untouched', () => {
  const u = new URL('https://api.example.com/path')
  const r = stripCredentialsOnCrossOrigin(u, { Authorization: 'Bearer xyz', 'X-Custom': 'ok' }, undefined)
  assert.deepEqual(r.headers, { Authorization: 'Bearer xyz', 'X-Custom': 'ok' })
  assert.equal(r.stripped, false)
  assert.equal(r.reason, null)
})

test('stripCredentialsOnCrossOrigin: same origin → credentials preserved', () => {
  const u = new URL('https://api.example.com/path')
  const profile = { name: 'p1', allowedOrigins: ['https://api.example.com'] }
  const r = stripCredentialsOnCrossOrigin(u, { Authorization: 'Bearer xyz', Cookie: 'sid=1' }, profile)
  assert.equal(r.stripped, false)
  assert.equal(r.headers.Authorization, 'Bearer xyz')
  assert.equal(r.headers.Cookie, 'sid=1')
})

test('stripCredentialsOnCrossOrigin: cross origin → strip Authorization + Cookie + X-Api-Key', () => {
  // SPEC §II.7 / acceptance #6
  const u = new URL('https://cdn.example.org/asset')
  const profile = { name: 'p1', allowedOrigins: ['https://api.example.com'] }
  const r = stripCredentialsOnCrossOrigin(u, {
    Authorization: 'Bearer xyz',
    Cookie: 'sid=1',
    'X-Api-Key': 'key',
    'X-Trace': 'keep-me',
  }, profile)
  assert.equal(r.stripped, true)
  assert.equal(r.headers.Authorization, undefined)
  assert.equal(r.headers.Cookie, undefined)
  assert.equal(r.headers['X-Api-Key'], undefined)
  assert.equal(r.headers['X-Trace'], 'keep-me', 'non-auth headers are preserved')
  assert.ok(r.reason && r.reason.includes('cdn.example.org'), r.reason)
})

test('stripCredentialsOnCrossOrigin: Proxy-Authorization also stripped', () => {
  const u = new URL('https://cdn.example.org/asset')
  const profile = { name: 'p1', allowedOrigins: ['https://api.example.com'] }
  const r = stripCredentialsOnCrossOrigin(u, {
    'Proxy-Authorization': 'Basic xyz',
  }, profile)
  assert.equal(r.headers['Proxy-Authorization'], undefined)
  assert.equal(r.stripped, true)
})

test('stripCredentialsOnCrossOrigin: case-insensitive header match', () => {
  const u = new URL('https://cdn.example.org/asset')
  const profile = { name: 'p1', allowedOrigins: ['https://api.example.com'] }
  const r = stripCredentialsOnCrossOrigin(u, {
    AUTHORIZATION: 'Bearer xyz',
    cookie: 'sid=1',
  }, profile)
  assert.equal(r.headers.AUTHORIZATION, undefined)
  assert.equal(r.headers.cookie, undefined)
  assert.equal(r.stripped, true)
})

test('originKey extracts scheme + host + port', () => {
  assert.equal(originKey(new URL('https://example.com:443/x')), 'https://example.com')
  assert.equal(originKey(new URL('http://api.example.com:8080/')), 'http://api.example.com:8080')
  assert.equal(originKey(new URL('https://example.com/')), 'https://example.com')
})

test('authHeadersFor: bearer', () => {
  assert.deepEqual(authHeadersFor({ type: 'bearer' }, 'xyz'), { Authorization: 'Bearer xyz' })
})

test('authHeadersFor: basic', () => {
  assert.deepEqual(authHeadersFor({ type: 'basic' }, 'user:pass'), { Authorization: 'Basic user:pass' })
})

test('authHeadersFor: cookie', () => {
  assert.deepEqual(authHeadersFor({ type: 'cookie' }, 'sid=1'), { Cookie: 'sid=1' })
})

test('authHeadersFor: empty value returns empty', () => {
  assert.deepEqual(authHeadersFor({ type: 'bearer' }, ''), {})
})
