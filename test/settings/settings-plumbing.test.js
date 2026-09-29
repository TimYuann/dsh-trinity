// test/settings/settings-plumbing.test.js — the v2.4.1 config-plumbing fix.
//
// Regression coverage for the defect this release fixes: DSH >= 0.1.7
// replaced the settings `register/get/watch` API with `SettingsForms`
// (`configure/describe/update/replace/mutate`) and resolves a plugin's
// exported `Config`. The plugin used to call `settings.register(...)`, get
// nothing back, and silently run with `{}` — every value in
// `cordis.patch.yml` was parsed and dropped.
//
// These tests pin the three parts of the fix:
//   1. the entry exports a Config schema that resolves defaults;
//   2. volatile config references are unwrapped on every read (live edits
//      write into the same reference without restarting the fiber);
//   3. read/write helpers speak the modern entry-id keyed form API.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, name, version, apply } from '../../lib/index.js'
import { WebAccessChainSchema } from '../../lib/config-schema.js'
import {
  registerSettings,
  createRuntimeSettings,
  readSettings,
  patchSetting,
  settingsEntryId,
} from '../../lib/settings/register.js'
import { isVolatileRef, unwrapVolatile } from '../../lib/settings/volatile.js'
import { chainedFetch } from '../../lib/providers/fetch/chained-fetch.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Build one real volatile reference the way cosmokit.createVolatile does. */
function volatileRef(initial) {
  let current = initial
  return {
    get: () => current,
    [VOLATILE_WRITE]: (next) => { current = next },
  }
}

/** A modern-host settings service: no register/get/watch, form API only. */
function modernSettingsService(rows) {
  const calls = { mutate: [], update: [], described: 0 }
  return {
    calls,
    describe() {
      calls.described += 1
      return rows
    },
    async update(ns, patch) { calls.update.push({ ns, patch }) },
    async mutate(ns, ops) { calls.mutate.push({ ns, ops }) },
  }
}

/** A ctx good enough for apply(): every service the entry injects. */
function stubHost(settings) {
  const state = { searchProviders: new Map(), fetchProviders: new Map(), tools: new Set(), commands: new Set(), skills: new Set() }
  const ctx = {
    fiber: { entry: { id: 'web-access-chain' } },
    state,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get(key) {
      if (key === 'settings') return settings
      if (key === 'web') {
        return {
          registerSearchProvider: (p) => { state.searchProviders.set(p.id, p); return () => {} },
          registerFetchProvider: (p) => { state.fetchProviders.set(p.id, p); return () => {} },
        }
      }
      if (key === 'tools') return { register: (t) => { state.tools.add(t.name); return () => {} }, get: () => undefined }
      if (key === 'commands') return { register: (c) => { state.commands.add(c.name); return () => {} } }
      if (key === 'skills') return { register: (s) => { state.skills.add(s.name); return () => {} } }
      if (key === 'systemPrompt') return { section: () => {} }
      if (key === 'logger') return null
      return undefined
    },
  }
  return ctx
}

// ── 1. the entry Config schema ────────────────────────────────────────

test('v2.4.1: the entry exports the Cordis Config schema', () => {
  assert.equal(name, 'web-access-chain')
  assert.equal(version, '2.4.1')
  assert.equal(typeof Config, 'function')
  assert.equal(Config, WebAccessChainSchema)
  assert.ok('toJSON' in Config, 'the settings service requires a serialisable schema')
})

test('v2.4.1: Config resolves schema defaults over a partial raw config', () => {
  const resolved = Config['~standard'].validate({ routing: 'aggregate' })
  assert.equal(resolved.issues, undefined)
  const value = unwrapVolatile(resolved.value)
  assert.equal(value.routing, 'aggregate')
  assert.equal(value.searchTotalTimeoutMs, 30000)
  assert.equal(value.adapters.genericHtml.enabled, true)
  assert.equal(value.tools.pdfExtract.enabled, false)
  assert.equal(value.sourceCheck.enabled, true)
  assert.equal(value.mmxFallback, true)
  assert.deepEqual(value.authFetch, {})
})

test('v2.4.1: Config accepts the values shipped in cordis.patch.yml', () => {
  const shipped = {
    routing: 'auto',
    searchTotalTimeoutMs: 30000,
    perProviderTimeoutMs: 8000,
    perKeyTimeoutMs: 8000,
    maxProvidersPerSearch: 18,
    maxKeysPerProvider: 3,
    aggregateMaxFanout: 4,
    cacheTtlMs: 3600000,
    cacheMaxEntries: 128,
    cacheMaxBytes: 134217728,
    fetchRoutingMode: 'http-only',
    fetchMaxResponseMB: 5,
    ssrf: { allowRanges: [], trustEnvProxy: false },
    proxy: null,
    domainPolicy: { allow: [], deny: [] },
    authFetch: {},
    adapters: {
      github: { enabled: true },
      youtube: { enabled: true },
      rss: { enabled: true },
      pdf: { enabled: true },
      genericHtml: { enabled: true },
    },
    tools: {
      githubPrIssue: { enabled: false },
      videoExtract: { enabled: false },
      pdfExtract: { enabled: false, maxPages: null, provider: 'unpdf' },
    },
    sourceCheck: { enabled: true, subQueryCount: 3, maxPagesFetch: 5, topPassagesPerSource: 3 },
    mmxFallback: true,
  }
  const resolved = Config['~standard'].validate(shipped)
  assert.equal(resolved.issues, undefined, 'the bundled patch must validate')
  const value = unwrapVolatile(resolved.value)
  assert.equal(value.adapters.genericHtml.enabled, true)
  assert.equal(value.tools.pdfExtract.provider, 'unpdf')
})

// ── 2. volatile references ────────────────────────────────────────────

test('v2.4.1: unwrapVolatile returns live values, not refs', () => {
  const ref = volatileRef(7)
  assert.equal(isVolatileRef(ref), true)
  assert.equal(isVolatileRef({ get: () => 7 }), false, 'a plain getter is not a volatile ref')
  const cfg = { a: ref, nested: { b: volatileRef('x') }, plain: [1, 2] }
  assert.deepEqual(unwrapVolatile(cfg), { a: 7, nested: { b: 'x' }, plain: [1, 2] })
  // A live edit writes into the SAME reference; the next unwrap sees it.
  ref[VOLATILE_WRITE](8)
  assert.equal(unwrapVolatile(cfg).a, 8)
})

test('v2.4.1: unwrapVolatile keeps object identity when nothing is volatile', () => {
  const plain = { a: 1, nested: { b: 2 } }
  assert.equal(unwrapVolatile(plain), plain)
})

// ── 3. settings handle, runtime ref, read/write helpers ───────────────

test('v2.4.1: registerSettings adopts the resolved Config on a modern host', () => {
  const settings = modernSettingsService([])
  const schema = Config
  const base = schema['~standard'].validate({}).value
  const ctx = { fiber: { entry: { id: 'web-access-chain' } }, get: (k) => (k === 'settings' ? settings : undefined) }

  const handle = registerSettings(ctx, { base })
  assert.ok(handle)
  assert.equal(handle.source, 'config', 'no legacy SettingsScope on a modern host')
  assert.equal(handle.scope, null)
  assert.equal(typeof handle.watch, 'function')
  assert.equal(handle.watch(() => {})(), undefined, 'watch is a no-op disposer')

  const value = handle.get()
  assert.equal(value.routing, 'auto')
  assert.equal(value.cacheMaxEntries, 128)
  assert.equal(isVolatileRef(value), false, 'reads must never leak a volatile ref')
})

test('v2.4.1: the runtime ref is read-through, so live edits are visible', () => {
  const ref = volatileRef('auto')
  const handle = { source: 'config', get: () => unwrapVolatile({ routing: ref, cacheMaxEntries: 128 }), watch: () => () => {} }
  const runtime = createRuntimeSettings(handle, {})
  assert.equal(runtime.get().routing, 'auto')
  ref[VOLATILE_WRITE]('aggregate')
  assert.equal(runtime.get().routing, 'aggregate', 'a volatile edit must be visible without a restart')
})

test('v2.4.1: replace() still wins once a legacy host pushes a whole object', () => {
  const runtime = createRuntimeSettings({ get: () => ({ routing: 'auto' }) }, {})
  runtime.replace({ routing: 'aggregate' })
  assert.equal(runtime.get().routing, 'aggregate')
})

test('v2.4.1: settingsEntryId prefers the Loader entry id', () => {
  assert.equal(settingsEntryId({ fiber: { entry: { id: 'custom-row' } } }), 'custom-row')
  assert.equal(settingsEntryId({}), 'web-access-chain')
  assert.equal(settingsEntryId({ get fiber() { throw new Error('disposed') } }), 'web-access-chain')
})

test('v2.4.1: readSettings uses describe() and matches the entry id', () => {
  const settings = modernSettingsService([
    { ns: 'other', value: { routing: 'auto' } },
    { ns: 'custom-row', value: { routing: 'aggregate', cacheMaxEntries: 4 } },
  ])
  const ctx = { fiber: { entry: { id: 'custom-row' } }, get: (k) => (k === 'settings' ? settings : undefined) }
  const value = readSettings(ctx)
  assert.equal(settings.calls.described, 1)
  assert.equal(value.cacheMaxEntries, 4)
})

test('v2.4.1: readSettings is null when no settings source exists', () => {
  assert.equal(readSettings({ get: () => undefined }), null)
  assert.equal(readSettings({ get: () => ({ describe: () => null }) }), null)
})

test('v2.4.1: patchSetting writes through mutate() with a real path op', async () => {
  const settings = modernSettingsService([])
  const ctx = { fiber: { entry: { id: 'web-access-chain' } }, get: (k) => (k === 'settings' ? settings : undefined) }
  await patchSetting(ctx, 'adapters.genericHtml.enabled', false)
  assert.deepEqual(settings.calls.mutate, [{
    ns: 'web-access-chain',
    ops: [{ op: 'set', path: ['adapters', 'genericHtml', 'enabled'], value: false }],
  }])
})

test('v2.4.1: patchSetting falls back to update() when mutate() is absent', async () => {
  const calls = []
  const settings = { async update(ns, patch) { calls.push({ ns, patch }) } }
  const ctx = { fiber: { entry: { id: 'web-access-chain' } }, get: (k) => (k === 'settings' ? settings : undefined) }
  await patchSetting(ctx, 'cacheMaxEntries', 64)
  assert.deepEqual(calls, [{ ns: 'web-access-chain', patch: { cacheMaxEntries: 64 } }])
})

test('v2.4.1: patchSetting never throws when the host rejects the write', async () => {
  const settings = { async mutate() { throw new Error('Config field "authFetch" is not volatile') } }
  const ctx = { get: (k) => (k === 'settings' ? settings : undefined) }
  await patchSetting(ctx, 'authFetch', {})
})

// ── 4. end-to-end: apply() must honour the resolved Config ────────────

test('v2.4.1: apply() honours a resolved Config gate (the shipped defect)', async () => {
  const settings = modernSettingsService([])
  const ctx = stubHost(settings)
  const raw = Config['~standard'].validate({ adapters: { genericHtml: { enabled: false } } }).value

  await apply(ctx, raw)
  assert.equal(ctx.state.searchProviders.has('web-access-chain-search'), true)
  assert.equal(ctx.state.fetchProviders.has('web-access-chain-fetch'), true)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('<html><body><p>hello</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  try {
    const result = await ctx.state.fetchProviders.get('web-access-chain-fetch').fetch({ url: 'https://example.com/' }, undefined)
    assert.equal(result.adapterId, 'generic-html-disabled',
      'settings.adapters.genericHtml.enabled=false must reach the fetch pipeline')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('v2.4.1: apply() log line counts the resolved config keys', async () => {
  const settings = modernSettingsService([])
  const ctx = stubHost(settings)
  const seen = []
  const originalInfo = console.info
  const originalError = console.error
  console.info = (...args) => { seen.push(args) }
  console.error = (...args) => { seen.push(args) }
  try {
    await apply(ctx, Config['~standard'].validate({}).value)
  } finally {
    console.info = originalInfo
    console.error = originalError
  }
  const init = seen.find((args) => args[0] === 'web-access-chain.init')
  assert.ok(init, 'apply() must log its init line')
  assert.ok(init[1] && init[1].settings > 10,
    `settings count must be the resolved config size, got ${JSON.stringify(init[1])}`)
})

// ── 5. the fetch pipeline reads the same live value ───────────────────

test('v2.4.1: chainedFetch consults the runtime settings it is handed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('<html><body><p>hello</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  try {
    const result = await chainedFetch({ url: 'https://example.com/' }, undefined, {
      ssrf: { allowRanges: [], trustEnvProxy: false },
      domainPolicy: { allow: [], deny: [] },
      maxBytes: 1024 * 1024,
      settings: { adapters: { genericHtml: { enabled: false } } },
      ctx: { get() { return undefined } },
    })
    assert.equal(result.adapterId, 'generic-html-disabled')
  } finally {
    globalThis.fetch = originalFetch
  }
})
