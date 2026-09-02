// test/optional-providers.test.js — kimi + parallelMcp + gemini ADC
// (Commit 3). These providers are explicit-only (R2 §1.3).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as kimi from '../lib/providers/search/kimi.js'
import * as parallelMcp from '../lib/providers/search/parallel-mcp.js'
import { AUTO_CHAIN_PROVIDERS, EXPLICIT_ONLY_PROVIDERS } from '../lib/config-schema.js'
import { PROVIDER_REGISTRY } from '../lib/providers/search/chained.js'

test('kimi is registered but explicit-only (R2 §1.3)', () => {
  assert.equal(PROVIDER_REGISTRY.kimi, kimi)
  assert.equal(kimi.ALL_ELIGIBLE, false, 'kimi is explicit-only')
  assert.ok(EXPLICIT_ONLY_PROVIDERS.includes('kimi'), 'kimi is in EXPLICIT_ONLY list')
  assert.ok(!AUTO_CHAIN_PROVIDERS.includes('kimi'), 'kimi is NOT in AUTO_CHAIN list')
})

test('parallelMcp is registered but explicit-only (R2 §1.3)', () => {
  assert.equal(PROVIDER_REGISTRY.parallelMcp, parallelMcp)
  assert.equal(parallelMcp.ALL_ELIGIBLE, false, 'parallelMcp is explicit-only')
  assert.ok(EXPLICIT_ONLY_PROVIDERS.includes('parallelMcp'))
  assert.ok(!AUTO_CHAIN_PROVIDERS.includes('parallelMcp'))
})

test('kimi providerSearch surfaces MISSING_API_KEY when no key is configured', async () => {
  await assert.rejects(
    kimi.providerSearch('test', 5, null, new AbortController().signal, {}),
    (e) => e.code === 'MISSING_API_KEY',
  )
})

test('parallelMcp providerSearch surfaces WEB_FETCH_FAILED when endpoint unreachable (no key set)', async () => {
  // We stub global fetch to simulate a network error.
  const orig = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    await assert.rejects(
      parallelMcp.providerSearch('test', 5, null, new AbortController().signal, {}),
      (e) => e.code === 'WEB_FETCH_FAILED',
    )
  } finally {
    globalThis.fetch = orig
  }
})
