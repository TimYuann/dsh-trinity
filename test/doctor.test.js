// test/doctor.test.js — Doctor passive default (SPEC §II.5 acceptance #19).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe } from '../lib/doctor/probe.js'
import { setPoolState } from '../lib/providers/search/chained.js'

function makeStubCtx() {
  return {
    session: { id: 'session-test' },
    get(key) {
      if (key === 'agents') return { currentInitiator() { return { sessionId: 'session-test' } } }
      if (key === 'settings') {
        return {
          get(ns) {
            if (ns === 'web-access-chain') {
              return {
                sourceCheck: { enabled: true },
                adapters: {
                  github: { enabled: true },
                  youtube: { enabled: true },
                  rss: { enabled: true },
                  pdf: { enabled: true },
                  genericHtml: { enabled: true },
                },
              }
            }
            return null
          },
        }
      }
      if (key === 'agentDefaultModel') return { currentSelection() { return { provider: 'test', model: 'test-model' } } }
      return null
    },
  }
}

/**
 * Same stub, but with a credentials seam that resolves exactly one ref.
 * Used to exercise the "credential exists but no request has measured it"
 * path — the state a user hits right after configuring a key, before any
 * search has run.
 */
function makeStubCtxWithCredential(ref) {
  const base = makeStubCtx()
  return {
    ...base,
    get(key) {
      if (key === 'credentials') {
        return {
          async resolve(r) {
            return r === ref ? { value: 'stub-value', source: 'test' } : undefined
          },
        }
      }
      return base.get(key)
    },
  }
}

test('createProbe returns a probe with run()', () => {
  const probe = createProbe(makeStubCtx(), null)
  assert.equal(typeof probe.run, 'function')
})

test('probe.run() default passive: returns a structured report (no network calls)', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  assert.equal(r.severity, 'ok')
  assert.ok(Array.isArray(r.providers))
  assert.ok(Array.isArray(r.adapters))
  assert.equal(typeof r.cache, 'object')
  assert.equal(typeof r.proxy, 'object')
  assert.equal(typeof r.identity, 'object')
  assert.equal(r.migration, undefined, 'migration field removed in v2.1 (no legacy-import)')
  assert.equal(typeof r.model, 'object')
  assert.equal(r.activeProbe, undefined, 'passive mode does NOT enable activeProbe')
})

test('probe.run({ activeProbe: true }) marks activeProbe', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({ activeProbe: true })
  assert.equal(r.activeProbe, true)
})

test('probe reports all 18 + 8 + 1 (mmx) providers', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  // v2.3.0: openai removed. 18 all-eligible + 8 explicit-only
  // (6 + kimi + parallelMcp) + 1 mmx = 27. anysearch moved from
  // explicit-only to auto chain on 2026-09-11; the total is unchanged.
  assert.equal(r.providers.length, 27)
})

test('probe reports 5 adapters', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  assert.equal(r.adapters.length, 5)
  const adapterIds = r.adapters.map((a) => a.id)
  assert.ok(adapterIds.includes('github'))
  assert.ok(adapterIds.includes('youtube'))
  assert.ok(adapterIds.includes('rss'))
  assert.ok(adapterIds.includes('pdf'))
  assert.ok(adapterIds.includes('genericHtml'))
})

test('probe reports identity fields', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  assert.ok(r.identity)
  // The sessionId field comes from ctx.agents.currentInitiator().sessionId
  // or ctx.session.id; at least one should be populated.
  assert.ok(r.identity.sessionIdField || r.identity.sessionIdAltField)
})

test('probe reports cache stats', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  assert.equal(typeof r.cache.entries, 'number')
  assert.equal(typeof r.cache.bytes, 'number')
  assert.equal(r.cache.hardCharCap, 20_000)
})

// ── Regression: `0 healthy` must mean "measured, and it failed" ───────
//
// 2026-09-11 incident: a user configured EXA_API_KEY, ran web_doctor
// before any search, and read `1 configured / 0 healthy` as "my key is
// broken". The key was fine (a live call returned HTTP 200). The zero
// was a hardcoded placeholder in the passive fallback, never a
// measurement. Health must not be reported as a number until something
// has actually observed it.

test('probe: configured-but-unprobed credential reports unknown health, not 0 healthy', async () => {
  const probe = createProbe(makeStubCtxWithCredential('EXA_API_KEY'), null)
  const r = await probe.run({})

  const exa = r.providers.find((p) => p.id === 'exa')
  assert.ok(exa, 'exa row must be present')
  assert.equal(exa.credentialsSource, 'unprobed', 'nothing has measured exa yet')
  assert.match(exa.credentials, /1 configured/, 'the configured count is still reported')
  assert.match(exa.credentials, /health unknown/, 'health must be reported as unknown')
  assert.ok(
    !/0 healthy/.test(exa.credentials),
    `unprobed credentials must not be rendered as "0 healthy"; got: ${exa.credentials}`,
  )

  // Providers with no resolvable credential keep the honest zero.
  const tavily = r.providers.find((p) => p.id === 'tavily')
  assert.equal(tavily.credentialsSource, 'none')
  assert.equal(tavily.credentials, '0 configured')
})

test('probe: an observed pool still reports numeric health', async () => {
  setPoolState('exa', [
    { credentialRef: 'EXA_API_KEY', state: 'healthy' },
    { credentialRef: 'EXA_API_KEY_2', state: 'invalid' },
  ])
  try {
    const probe = createProbe(makeStubCtx(), null)
    const r = await probe.run({})
    const exa = r.providers.find((p) => p.id === 'exa')
    assert.equal(exa.credentialsSource, 'observed')
    assert.equal(exa.credentials, '2 configured / 1 healthy / 0 cooldown / 1 invalid')
  } finally {
    setPoolState('exa', [])
  }
})
