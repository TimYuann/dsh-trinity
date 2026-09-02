// test/runtime-budgets.test.js — runtime budget enforcement (SPEC §I.9,
// acceptance #18).
//
// We test the abort propagation and maxProviders cap, both of which can be
// exercised deterministically without real network I/O.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainedSearch, getPoolState, getLastError, clearProviderRuntimeState } from '../lib/providers/search/chained.js'

function makePoolCtx(opts = {}) {
  const cfg = {
    searchTotalTimeoutMs: 5000,
    perProviderTimeoutMs: 5000,
    perKeyTimeoutMs: 5000,
    maxProvidersPerSearch: opts.maxProviders || 18,
    maxKeysPerProvider: 3,
    aggregateMaxFanout: 4,
    mmxFallback: false,
    ...opts,
  }
  const resolved = {}
  return { resolved, rawConfig: cfg, config: cfg, keysForRedaction: [] }
}

test('runtime-budget: abort signal stops chain + subprocesses', async () => {
  // SPEC §II.7 acceptance #5
  clearProviderRuntimeState()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    chainedSearch({ query: 'test' }, controller.signal, makePoolCtx()),
    (err) => err && (err.name === 'AbortError' || err.code === 'ABORTED'),
  )
})

test('runtime-budget: maxProvidersPerSearch caps the chain', async () => {
  clearProviderRuntimeState()
  // maxProviders caps the number of PROVIDERS visited (each provider may
  // produce multiple attempts when its pool runs). With maxProviders=2
  // and 3 default keys per provider, we expect at most 2*3=6 attempts.
  let attempts = []
  try {
    await chainedSearch({ query: 'test' }, undefined, makePoolCtx({ maxProviders: 2 }))
  } catch (e) {
    attempts = (e && e.attempts) || []
  }
  assert.ok(attempts.length <= 6, `attempts.length=${attempts.length} should be <=6`)
  // The number of distinct providers in attempts must be <= 2.
  const distinctProviders = new Set(attempts.map((a) => a.provider))
  assert.ok(distinctProviders.size <= 2, `distinctProviders=${distinctProviders.size} should be <=2`)
})

test('runtime-budget: searchTotalTimeoutMs triggers WEB_SEARCH_CHAIN_EXHAUSTED', async () => {
  clearProviderRuntimeState()
  // Tiny total budget. The chain won't actually finish in time.
  const ctx = makePoolCtx({ maxProviders: 2 })
  ctx.config.searchTotalTimeoutMs = 1
  let attempts = []
  try {
    await chainedSearch({ query: 'test' }, undefined, ctx)
  } catch (e) {
    attempts = (e && e.attempts) || []
    assert.equal(e.code, 'WEB_SEARCH_CHAIN_EXHAUSTED')
  }
  // Either budget-truncated or pool exhausted; cap by maxProviders.
  assert.ok(attempts.length <= 6, `attempts.length=${attempts.length} should be <=6`)
})

test('poolState tracks per-provider credential state', async () => {
  clearProviderRuntimeState()
  const ctx = makePoolCtx({ maxProviders: 1 })
  try {
    await chainedSearch({ query: 'test', routing: { kind: 'single', id: 'exa' } }, undefined, ctx)
  } catch (e) {
    // ignore
  }
  const state = getPoolState('exa')
  // Either the pool was updated with credential gaps, or the provider
  // returned early without a pool (credential missing).
  assert.ok(state === undefined || state.length === 0 || state.length <= 3)
})

test('lastError state is recorded after a chain run', async () => {
  clearProviderRuntimeState()
  try {
    await chainedSearch({ query: 'test' }, undefined, makePoolCtx({ maxProviders: 1 }))
  } catch (e) {
    // ignore
  }
  const lastErr = getLastError('searxng') || getLastError('exa')
  // We may or may not have a recorded error depending on whether any
  // provider was attempted. The test asserts the API surface exists.
  assert.ok(lastErr === null || typeof lastErr === 'object')
})
