// test/aggregate-eligibility.test.js — defect A: aggregate fan-out must be
// limited to providers that can actually be attempted.
//
// Observed on the main instance (2026-09-11): a single
// `web_search_ex(routing="aggregate")` on a chain where only exa/anysearch
// hold keys produced ~45 lines of
//   - brave: BRAVE_API_KEY:credential
//   - brave: BRAVE_API_KEY_2:credential
// and, worse, persisted a placeholder pool per keyless provider, so the
// next `web_doctor` reported "3 configured / 0 healthy / …" for providers
// that have no credential at all.
//
// These tests pin the fan-out half of the fix. The reporting half
// (poolSummary ignoring placeholder slots) is covered in
// test/credentials/pool.test.js and test/doctor.test.js. The last case
// runs the exact three-step recipe from the handoff (doctor → aggregate →
// doctor) in one process, because that sequence is what the user saw.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainedSearch, getPoolState, setPoolState, poolSummary } from '../lib/providers/search/chained.js'
import { createProbe } from '../lib/doctor/probe.js'

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * chained ctx whose DSH credential seam resolves exactly the given refs.
 * @param {string[]} refs
 * @param {{ rawConfig?: any, config?: any }} [extra]
 */
function makeChainedCtx(refs, extra = {}) {
  const resolvable = new Set(refs)
  return {
    resolved: {},
    rawConfig: extra.rawConfig || {},
    config: { mmxFallback: false, ...(extra.config || {}) },
    keysForRedaction: [],
    ctx: {
      get(key) {
        if (key === 'credentials') {
          return {
            async resolve(ref) {
              return resolvable.has(ref) ? { value: `stub-${ref}`, source: 'test' } : undefined
            },
          }
        }
        return null
      },
    },
  }
}

function stubFetch() {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('api.exa.ai')) {
      return new Response(JSON.stringify({
        results: [{ url: 'https://exa.example/1', title: 'exa hit', highlights: ['exa snippet'] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('api.anysearch.com')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { results: [{ url: 'https://anysearch.example/1', title: 'anysearch hit', snippet: 'anysearch snippet' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('api.tavily.com')) {
      return new Response(JSON.stringify({
        results: [{ url: 'https://tavily.example/1', title: 'tavily hit', content: 'tavily snippet' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('', { status: 404 })
  }
  return {
    calls,
    hosts: () => calls.map((u) => new URL(u).host),
    restore: () => { globalThis.fetch = orig },
  }
}

/** Clear the module-level pool state the doctor reads back. */
function resetPools(ids) {
  for (const id of ids) setPoolState(id, [])
}

// ─────────────────────────────────────────────────────────────────────
// A.1 — keyless providers never enter the fan-out
// ─────────────────────────────────────────────────────────────────────

test('aggregate: fans out only to credentialed providers', async () => {
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    const ctx = makeChainedCtx(['EXA_API_KEY'])
    const r = await chainedSearch({ query: 'defect a', routing: 'aggregate' }, undefined, ctx)

    assert.equal(r.provider, 'aggregate')
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0].url, 'https://exa.example/1')
    assert.deepEqual(stub.hosts(), ['api.exa.ai'], 'only the credentialed provider may be called')
    assert.equal(r.providerErrors, undefined, 'keyless providers must not report provider errors')
  } finally {
    stub.restore()
  }
})

test('aggregate: keyless providers leave no pool state behind', async () => {
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    const ctx = makeChainedCtx(['EXA_API_KEY'])
    await chainedSearch({ query: 'defect a', routing: 'aggregate' }, undefined, ctx)

    // The reported damage: a keyless provider read back as "3 configured".
    for (const id of ['brave', 'tavily', 'anysearch']) {
      assert.deepEqual(getPoolState(id), [], `${id} must not gain a placeholder pool`)
      assert.equal(poolSummary(getPoolState(id)).configured, 0, `${id} is not configured`)
    }
    // The provider that actually ran keeps its real pool, with slot 1
    // resolved (fingerprint) and measured (healthy).
    const exaPool = getPoolState('exa')
    assert.equal(exaPool.length, 3)
    assert.equal(exaPool[0].state, 'healthy')
    assert.ok(exaPool[0].fingerprint, 'resolved slot carries a fingerprint')
    assert.equal(exaPool[1].fingerprint, undefined, 'empty slot is a placeholder')
    assert.equal(poolSummary(exaPool).configured, 1, 'exactly one key is configured')
  } finally {
    stub.restore()
  }
})

// ─────────────────────────────────────────────────────────────────────
// A.2 — keyless providers must not consume the maxProviders budget
// ─────────────────────────────────────────────────────────────────────

test('aggregate: maxProviders budget is spent on real attempts (anysearch is 18th in the chain)', async () => {
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    // Only the LAST provider in the auto chain holds a credential, with a
    // budget of one attempt. Before the fix, exa/brave/… each burned the
    // budget by "trying" a key that does not exist, and the run exhausted
    // without ever reaching the provider that could answer.
    const ctx = makeChainedCtx(['ANYSEARCH_API_KEY'], { config: { maxProvidersPerSearch: 1 } })
    const r = await chainedSearch({ query: 'budget', routing: 'aggregate' }, undefined, ctx)

    assert.deepEqual(stub.hosts(), ['api.anysearch.com'])
    assert.equal(r.sources[0].url, 'https://anysearch.example/1')
  } finally {
    stub.restore()
  }
})

// ─────────────────────────────────────────────────────────────────────
// A.3 — eligibility must not drop providers configured outside the pool
// ─────────────────────────────────────────────────────────────────────

test('aggregate: a provider configured via rawConfig field is still eligible', async () => {
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    // No credential-seam hits at all: rawConfig.tavilyApiKey is the only
    // key in play (the last-resort path resolveProviderKey honours). A
    // prefilter that only asked the credential seam would drop it.
    const ctx = makeChainedCtx([], { rawConfig: { tavilyApiKey: 'raw-config-key' } })
    const r = await chainedSearch({ query: 'rawconfig', routing: 'aggregate' }, undefined, ctx)

    assert.deepEqual(stub.hosts(), ['api.tavily.com'])
    assert.equal(r.sources[0].url, 'https://tavily.example/1')
  } finally {
    stub.restore()
  }
})

// ─────────────────────────────────────────────────────────────────────
// A.4 — nothing credentialed at all: one honest failure, no fan-out
// ─────────────────────────────────────────────────────────────────────

test('aggregate: zero credentialed providers fails fast with a clear reason', async () => {
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    const ctx = makeChainedCtx([])
    await assert.rejects(
      chainedSearch({ query: 'nothing configured', routing: 'aggregate' }, undefined, ctx),
      (err) => {
        assert.equal(err.code, 'WEB_PROVIDER_ERROR')
        assert.match(err.message, /no.*provider.*credentials/i)
        assert.equal(err.doctorRecommended, true)
        return true
      },
    )
    assert.deepEqual(stub.calls, [], 'no provider may be contacted when none is configured')
  } finally {
    stub.restore()
  }
})

// ─────────────────────────────────────────────────────────────────────
// A.5 — the reported recipe, end to end in one process
// ─────────────────────────────────────────────────────────────────────

/**
 * DSH ctx stub shaped like the doctor's (settings / agents / session /
 * agentDefaultModel) plus a credentials seam that resolves only `refs`.
 * @param {string[]} refs
 */
function makeDshCtx(refs) {
  const resolvable = new Set(refs)
  return {
    session: { id: 'session-defect-a' },
    get(key) {
      if (key === 'credentials') {
        return {
          async resolve(ref) {
            return resolvable.has(ref) ? { value: `stub-${ref}`, source: 'test' } : undefined
          },
        }
      }
      if (key === 'agents') return { currentInitiator: () => ({ sessionId: 'session-defect-a' }) }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
      if (key === 'settings') return { get: () => null, on: () => () => {} }
      return null
    },
  }
}

test('A.5: doctor → aggregate → doctor keeps keyless providers at "0 configured"', async () => {
  // The exact sequence the user ran: check the panel, run one aggregate
  // search, check the panel again. Keyless providers went from
  // "0 configured" to "3 configured / 0 healthy / 0 cooldown / 0 invalid".
  resetPools(['exa', 'brave', 'tavily', 'anysearch'])
  const stub = stubFetch()
  try {
    const dshCtx = makeDshCtx(['EXA_API_KEY'])
    const probe = createProbe(dshCtx, null)
    const rowOf = async (id) => (await probe.run({})).providers.find((p) => p.id === id)

    assert.equal((await rowOf('brave')).credentials, '0 configured', 'baseline: brave has no key')
    assert.equal((await rowOf('tavily')).credentials, '0 configured', 'baseline: tavily has no key')

    const chainedCtx = { ...makeChainedCtx(['EXA_API_KEY']), ctx: dshCtx }
    const r = await chainedSearch({ query: 'doctor recipe', routing: 'aggregate' }, undefined, chainedCtx)
    assert.equal(r.sources.length, 1)

    for (const id of ['brave', 'tavily', 'anysearch']) {
      const row = await rowOf(id)
      assert.equal(row.credentialsSource, 'none', `${id} was never attempted`)
      assert.equal(row.credentials, '0 configured', `${id} must not report fabricated credentials`)
    }
    // exa did run, so its row is a measurement and may show its real counts.
    assert.equal((await rowOf('exa')).credentials, '1 configured / 1 healthy / 0 cooldown / 0 invalid')
    assert.equal(
      (await probe.run({})).providers.filter((p) => /configured/.test(p.credentials) && !/^0 configured/.test(p.credentials))
        .map((p) => p.id).join(','),
      'exa',
      'only the provider that actually ran may report a non-zero credential row',
    )
  } finally {
    stub.restore()
  }
})
