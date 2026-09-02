// test/classify-error.test.js — unified error classification (SPEC §II.8).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyError,
  isKeyRetryable,
  isFallbackable,
  quotaCooldownMs,
  withClass,
  ERROR_CLASSES,
} from '../lib/classify-error.js'

test('classifyError: aborted', () => {
  const e = new Error('whatever')
  e.name = 'AbortError'
  assert.equal(classifyError(e), 'aborted')
  const e2 = new Error('aborted by user')
  assert.equal(classifyError(e2), 'aborted')
})

test('classifyError: quota triggers on 429', () => {
  assert.equal(classifyError(new Error('HTTP 429 quota exceeded')), 'quota')
  assert.equal(classifyError(new Error('429 Too Many Requests')), 'quota')
  assert.equal(classifyError(new Error('quota exceeded for current billing period')), 'quota')
})

test('classifyError: quotaCooldown marks gemini RESOURCE_EXHAUSTED + xAI spending-limit', () => {
  assert.equal(classifyError(new Error('RESOURCE_EXHAUSTED: you exceeded your quota')), 'quota')
  assert.equal(classifyError(new Error('xAI spending-limit reached')), 'quota')
})

test('classifyError: auth on 401 / 403', () => {
  assert.equal(classifyError(new Error('HTTP 401 unauthorized')), 'auth')
  assert.equal(classifyError(new Error('HTTP 403 forbidden')), 'auth')
  assert.equal(classifyError(new Error('unauthorized: invalid API key')), 'auth')
})

test('classifyError: invalid-request on 400', () => {
  assert.equal(classifyError(new Error('HTTP 400 bad request')), 'invalid-request')
  assert.equal(classifyError(new Error('invalid request body')), 'invalid-request')
})

test('classifyError: invalid-response on parse fail / empty', () => {
  assert.equal(classifyError(new Error('invalid json response from upstream')), 'invalid-response')
  assert.equal(classifyError(new Error('no results returned')), 'invalid-response')
  assert.equal(classifyError(new Error('empty results')), 'invalid-response')
})

test('classifyError: network on ECONNRESET / DNS / connect', () => {
  assert.equal(classifyError(new Error('econnreset: connection lost')), 'network')
  assert.equal(classifyError(new Error('enotfound: DNS lookup failed')), 'network')
  assert.equal(classifyError(new Error('etimedout: connection timed out')), 'network')
  assert.equal(classifyError(new Error('fetch failed')), 'network')
})

test('classifyError: transient on 5xx', () => {
  assert.equal(classifyError(new Error('HTTP 503 service unavailable')), 'transient')
  assert.equal(classifyError(new Error('HTTP 502 bad gateway')), 'transient')
  assert.equal(classifyError(new Error('HTTP 500 internal server error')), 'transient')
  assert.equal(classifyError(new Error('HTTP 504 gateway timeout')), 'transient')
})

test('classifyError: security on SSRF / cross-Origin', () => {
  assert.equal(classifyError(new Error('ssrf blocked: 127.0.0.1')), 'security')
  assert.equal(classifyError(new Error('cross-origin redirect stripped credentials')), 'security')
})

test('classifyError: config on schema failure', () => {
  assert.equal(classifyError(new Error('invalid json config: top-level must be an object')), 'config')
  assert.equal(classifyError(new Error('ADC misconfigured: no credentials')), 'config')
  assert.equal(classifyError(new Error('proxy required but not set')), 'config')
})

test('classifyError: credential on missing key / placeholder', () => {
  assert.equal(classifyError(new Error('Missing API key for exa')), 'credential')
  assert.equal(classifyError(new Error('PLACEHOLDER value not allowed')), 'credential')
  assert.equal(classifyError(new Error('Missing SEARXNG_HOST')), 'credential')
})

test('classifyError: unknown for anything else', () => {
  assert.equal(classifyError(new Error('something completely different')), 'unknown')
  assert.equal(classifyError(null), 'unknown')
})

test('classifyError: explicit err.class wins', () => {
  const e = new Error('looks like transient but caller says quota')
  Object.defineProperty(e, 'class', { value: 'quota', configurable: true })
  assert.equal(classifyError(e), 'quota')
})

test('classifyError: WebError codes map cleanly', () => {
  const e1 = new Error('whatever')
  e1.code = 'WEB_BLOCKED_URL'
  assert.equal(classifyError(e1), 'security')

  const e2 = new Error('whatever')
  e2.code = 'WEB_PROVIDER_BAD_REQUEST'
  assert.equal(classifyError(e2), 'invalid-request')

  const e3 = new Error('whatever')
  e3.code = 'MISSING_API_KEY'
  assert.equal(classifyError(e3), 'credential')
})

test('isKeyRetryable: only transient + network', () => {
  assert.equal(isKeyRetryable('transient'), true)
  assert.equal(isKeyRetryable('network'), true)
  assert.equal(isKeyRetryable('quota'), false, 'quota moves to next credential without retry')
  assert.equal(isKeyRetryable('auth'), false)
  assert.equal(isKeyRetryable('invalid-response'), false)
  assert.equal(isKeyRetryable('aborted'), false)
  assert.equal(isKeyRetryable('security'), false)
})

test('isFallbackable: transient / quota / network / invalid-response / credential', () => {
  for (const c of ['transient', 'quota', 'network', 'invalid-response', 'credential']) {
    assert.equal(isFallbackable(c), true, c)
  }
  for (const c of ['auth', 'config', 'invalid-request', 'aborted', 'security', 'budget', 'unknown']) {
    assert.equal(isFallbackable(c), false, c)
  }
})

test('quotaCooldownMs: Retry-After header honored', () => {
  const e = new Error('quota')
  e.headers = { 'retry-after': '120' }
  assert.equal(quotaCooldownMs('quota', e), 120_000)
})

test('quotaCooldownMs: defaults to 60s when no Retry-After', () => {
  assert.equal(quotaCooldownMs('quota', new Error('quota exceeded')), 60_000)
  assert.equal(quotaCooldownMs('quota', null), 60_000)
})

test('quotaCooldownMs: returns null for non-quota classes', () => {
  assert.equal(quotaCooldownMs('auth', new Error('401')), null)
  assert.equal(quotaCooldownMs('network', new Error('econnreset')), null)
})

test('withClass attaches non-enumerable class', () => {
  const e = withClass(new Error('quota exceeded'), 'quota')
  assert.equal(e.class, 'quota')
  assert.equal(e.message, 'quota exceeded')
})

test('ERROR_CLASSES is the locked set', () => {
  for (const expected of ['transient', 'quota', 'network', 'invalid-response', 'auth',
                         'credential', 'config', 'invalid-request', 'aborted', 'security',
                         'budget', 'unknown']) {
    assert.ok(ERROR_CLASSES.includes(expected), expected)
  }
  assert.equal(ERROR_CLASSES.length, 12)
})
