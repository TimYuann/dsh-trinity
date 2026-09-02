// test/credentials/pool.test.js — Credential Pool state machine + runner
// (SPEC §II.3.3 acceptance #2, #3, #4, #5).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPool,
  transitionState,
  clearExpiredCooldown,
  runPool,
  poolSummary,
} from '../../lib/credentials/pool.js'

test('buildPool: one entry per slot (cap 3)', () => {
  const loaded = {
    resolved: {
      'BRAVE_API_KEY': { key: 'k1', source: 'env', raw: 'BRAVE_API_KEY' },
      'BRAVE_API_KEY_2': { key: 'k2', source: 'env', raw: 'BRAVE_API_KEY_2' },
      'BRAVE_API_KEY_3': null,
    },
  }
  const pool = buildPool('brave', loaded, 3)
  assert.equal(pool.length, 3)
  assert.equal(pool[0].credentialRef, 'BRAVE_API_KEY')
  assert.equal(pool[1].credentialRef, 'BRAVE_API_KEY_2')
  assert.equal(pool[2].credentialRef, 'BRAVE_API_KEY_3')
})

test('buildPool: respects maxKeys cap', () => {
  const loaded = {
    resolved: {
      'EXA_API_KEY': { key: 'k1', source: 'env', raw: 'EXA_API_KEY' },
      'EXA_API_KEY_2': { key: 'k2', source: 'env', raw: 'EXA_API_KEY_2' },
      'EXA_API_KEY_3': { key: 'k3', source: 'env', raw: 'EXA_API_KEY_3' },
    },
  }
  const pool = buildPool('exa', loaded, 2)
  assert.equal(pool.length, 2)
})

test('transitionState: quota → quotaCooldown with cooldownUntil', () => {
  const before = { credentialRef: 'webAccessChain_brave_1', state: 'unknown' }
  const after = transitionState(before, 'quota', 120_000)
  assert.equal(after.state, 'quotaCooldown')
  assert.ok(after.cooldownUntil > Date.now() + 100_000, 'cooldownUntil is in the future')
  assert.equal(after.lastErrorClass, 'quota')
})

test('transitionState: auth → invalid', () => {
  const before = { credentialRef: 'webAccessChain_brave_1', state: 'unknown' }
  const after = transitionState(before, 'auth')
  assert.equal(after.state, 'invalid')
  assert.equal(after.lastErrorClass, 'auth')
})

test('transitionState: transient / network / invalid-response do NOT change state', () => {
  const before = { credentialRef: 'webAccessChain_brave_1', state: 'unknown' }
  for (const cls of ['transient', 'network', 'invalid-response', 'unknown']) {
    const after = transitionState(before, cls)
    assert.equal(after.state, 'unknown', cls)
    assert.equal(after.lastErrorClass, cls)
  }
})

test('clearExpiredCooldown: expired cooldown returns to unknown', () => {
  const entry = {
    credentialRef: 'webAccessChain_brave_1',
    state: 'quotaCooldown',
    cooldownUntil: Date.now() - 1000,
    lastErrorClass: 'quota',
  }
  const cleared = clearExpiredCooldown(entry, Date.now())
  assert.equal(cleared.state, 'unknown')
  assert.equal(cleared.cooldownUntil, undefined)
})

test('clearExpiredCooldown: future cooldown is preserved', () => {
  const entry = {
    credentialRef: 'webAccessChain_brave_1',
    state: 'quotaCooldown',
    cooldownUntil: Date.now() + 60_000,
    lastErrorClass: 'quota',
  }
  const same = clearExpiredCooldown(entry, Date.now())
  assert.equal(same.state, 'quotaCooldown')
})

test('runPool: success on first key marks healthy and returns', async () => {
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => ({ sources: [{ url: 'https://example.com' }], truncated: false }),
    signal: undefined,
  })
  assert.equal(r.ok, true)
  assert.equal(r.pool[0].state, 'healthy')
  assert.equal(r.pool[1].state, 'unknown', 'second key untouched')
})

test('runPool: 429 on key 1 → quotaCooldown, key 2 healthy', async () => {
  // SPEC §II.3.3 / acceptance #2
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  let call = 0
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => {
      call++
      if (call === 1) {
        const e = new Error('HTTP 429 quota exceeded')
        e.code = 'HTTP_429'
        throw e
      }
      return { sources: [{ url: 'https://example.com' }], truncated: false }
    },
    signal: undefined,
  })
  assert.equal(r.ok, true)
  assert.equal(r.pool[0].state, 'quotaCooldown')
  assert.equal(r.pool[0].lastErrorClass, 'quota')
  assert.equal(r.pool[1].state, 'healthy')
  assert.equal(call, 2)
})

test('runPool: 401 on key 1 → invalid, key 2 healthy', async () => {
  // SPEC §II.3.3
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  let call = 0
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => {
      call++
      if (call === 1) {
        const e = new Error('HTTP 401 unauthorized')
        e.code = 'HTTP_401'
        throw e
      }
      return { sources: [{ url: 'https://example.com' }], truncated: false }
    },
    signal: undefined,
  })
  assert.equal(r.ok, true)
  assert.equal(r.pool[0].state, 'invalid')
  assert.equal(r.pool[0].lastErrorClass, 'auth')
  assert.equal(r.pool[1].state, 'healthy')
})

test('runPool: 503 retries SAME key once, then moves on', async () => {
  // SPEC §II.3.3 / acceptance #3 — pool does NOT rotate on 5xx.
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  let call = 0
  const seenCreds = []
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async (_ref, _sig, picked) => {
      call++
      seenCreds.push(picked)
      if (call <= 2) {
        const e = new Error('HTTP 503 service unavailable')
        e.code = 'HTTP_503'
        throw e
      }
      return { sources: [{ url: 'https://example.com' }], truncated: false }
    },
    signal: undefined,
  })
  assert.equal(r.ok, true)
  // First two attempts hit key 1 (retry once on transient); third call hits key 2.
  assert.deepEqual(seenCreds, [
    'webAccessChain_brave_1',
    'webAccessChain_brave_1',
    'webAccessChain_brave_2',
  ])
})

test('runPool: network retry same key once, then moves on', async () => {
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  let call = 0
  const seen = []
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async (_ref, _sig, picked) => {
      call++
      seen.push(picked)
      if (call <= 2) {
        const e = new Error('econnreset: connection lost')
        throw e
      }
      return { sources: [{ url: 'https://example.com' }], truncated: false }
    },
    signal: undefined,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(seen, ['webAccessChain_brave_1', 'webAccessChain_brave_1', 'webAccessChain_brave_2'])
})

test('runPool: all keys auth-fail → pool exhausted, ok=false', async () => {
  // SPEC §II.3.3 / acceptance #4 — pool exhaustion surfaces for next-provider fallback.
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => {
      const e = new Error('HTTP 401 unauthorized')
      e.code = 'HTTP_401'
      throw e
    },
    signal: undefined,
  })
  assert.equal(r.ok, false)
  assert.equal(r.class, 'auth')
  assert.equal(r.pool[0].state, 'invalid')
  assert.equal(r.pool[1].state, 'invalid')
  assert.equal(r.attempts.length, 2)
})

test('runPool: invalid-response drains pool (no key drain)', async () => {
  // SPEC §II.3.3 — invalid-response: no state change, moves to next provider.
  const pool = [
    { credentialRef: 'webAccessChain_brave_1', state: 'unknown' },
    { credentialRef: 'webAccessChain_brave_2', state: 'unknown' },
  ]
  const r = await runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => {
      const e = new Error('invalid json response from upstream')
      throw e
    },
    signal: undefined,
  })
  assert.equal(r.ok, false)
  assert.equal(r.class, 'invalid-response')
  assert.equal(r.pool[0].state, 'unknown', 'invalid-response must NOT change state')
})

test('runPool: abort signal propagates immediately', async () => {
  const controller = new AbortController()
  const pool = [{ credentialRef: 'webAccessChain_brave_1', state: 'unknown' }]
  const promise = runPool({
    providerId: 'brave',
    pool,
    maxKeys: 3,
    perKeyTimeoutMs: 1000,
    keysForRedaction: [],
    fetch: async () => {
      controller.abort()
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    },
    signal: controller.signal,
  })
  await assert.rejects(promise, (err) => err.name === 'AbortError')
})

test('runPool: security throws without retry', async () => {
  const pool = [{ credentialRef: 'webAccessChain_brave_1', state: 'unknown' }]
  await assert.rejects(
    runPool({
      providerId: 'brave',
      pool,
      maxKeys: 3,
      perKeyTimeoutMs: 1000,
      keysForRedaction: [],
      fetch: async () => {
        const e = new Error('ssrf blocked: 127.0.0.1')
        throw e
      },
      signal: undefined,
    }),
    (err) => /ssrf/.test(err.message),
  )
})

test('poolSummary counts states', () => {
  const pool = [
    { credentialRef: 'a.1', state: 'healthy' },
    { credentialRef: 'a.2', state: 'quotaCooldown' },
    { credentialRef: 'a.3', state: 'invalid' },
    { credentialRef: 'a.4', state: 'unknown' },
  ]
  const s = poolSummary(pool)
  assert.deepEqual(s, { configured: 4, healthy: 1, cooldown: 1, invalid: 1, unknown: 1 })
})
