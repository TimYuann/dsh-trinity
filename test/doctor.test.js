// test/doctor.test.js — Doctor passive default (SPEC §II.5 acceptance #19).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe } from '../lib/doctor/probe.js'

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

test('probe reports all 18 + 9 + 1 (mmx) providers', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const r = await probe.run({})
  // 18 all-eligible + 9 explicit-only (7 + kimi + parallelMcp) + 1 mmx = 28
  assert.equal(r.providers.length, 28)
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
