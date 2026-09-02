// test/contract/cordis-strict-ctx.test.js — Cordis strict-property contract
// (regression lock for the 2026-08-27 bug report).
//
// Real Cordis throws `cannot get property "<X>" without inject` when plugin
// code reads a service as a plain property (ctx.llm / ctx.session /
// ctx.agentDefaultModel) without declaring it in `inject`. The old unit
// tests stubbed those as plain JS properties, so all four inject bugs
// slipped through. This suite drives every Tool / probe / skill / command
// through a Proxy ctx that throws on any undeclared property access —
// exactly like the live host.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTool as createWebSearchEx } from '../../lib/tools/web-search-ex.js'
import { createTool as createWebDoctor } from '../../lib/tools/web-doctor.js'
import { createTool as createSearchContent } from '../../lib/tools/search-content.js'
import { createTool as createSourceCheck } from '../../lib/tools/source-check.js'
import { createProbe } from '../../lib/doctor/probe.js'
import { registerWebAccessSkill } from '../../lib/skills/web-access.js'
import { registerWebAccessDoctorSkill } from '../../lib/skills/web-access-doctor.js'
import { createCommand as createKeysCmd } from '../../lib/commands/webdoctor-keys.js'

/**
 * Build a Cordis-strict ctx: any property access not explicitly provided
 * throws `cannot get property "<X>" without inject`. Services are only
 * reachable through `ctx.get(name)`.
 *
 * @param {object} services  map of service name → stub
 */
function makeStrictCtx(services) {
  const base = {
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    },
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'get') return Reflect.get(target, prop, receiver)
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/** Real-shape credentials seam stub: plain env-name refs. */
function makeCredentialsStub() {
  return {
    async resolve(ref) {
      void ref
      return undefined
    },
    async describe(ref) {
      void ref
      return { configured: false, writable: true }
    },
    async set() { throw new Error('not implemented') },
    async unset() { throw new Error('not implemented') },
  }
}

function makeSettingsStub(overrides = {}) {
  return {
    get(ns) {
      if (ns === 'web-access-chain') return {
        cacheTtlMs: 3600000,
        cacheMaxEntries: 128,
        cacheMaxBytes: 134217728,
        fetchRoutingMode: 'http-only',
        fetchMaxResponseMB: 5,
        ssrf: { allowRanges: [], trustEnvProxy: false },
        domainPolicy: { allow: [], deny: [] },
        adapters: { github: { enabled: true }, youtube: { enabled: true }, rss: { enabled: true }, pdf: { enabled: true }, genericHtml: { enabled: true } },
        tools: { githubPrIssue: { enabled: false }, videoExtract: { enabled: false }, pdfExtract: { enabled: false } },
        sourceCheck: { enabled: true, subQueryCount: 3, maxPagesFetch: 5, topPassagesPerSource: 3 },
        ...overrides,
      }
      if (ns === 'dsh.profile') return { id: 'profile-test' }
      return undefined
    },
  }
}

const SETTINGS = {
  cacheTtlMs: 3600000,
  cacheMaxEntries: 128,
  cacheMaxBytes: 134217728,
  fetchRoutingMode: 'http-only',
  fetchMaxResponseMB: 5,
  ssrf: { allowRanges: [], trustEnvProxy: false },
  domainPolicy: { allow: [], deny: [] },
  adapters: { github: { enabled: true }, youtube: { enabled: true }, rss: { enabled: true }, pdf: { enabled: true }, genericHtml: { enabled: true } },
  tools: { githubPrIssue: { enabled: false }, videoExtract: { enabled: false }, pdfExtract: { enabled: false } },
  sourceCheck: { enabled: true, subQueryCount: 3, maxPagesFetch: 2, topPassagesPerSource: 2 },
}

/** Build the full tool wiring with a strict ctx (no llm/agentDefaultModel). */
function makeToolCtx() {
  const ctx = makeStrictCtx({
    credentials: makeCredentialsStub(),
    settings: makeSettingsStub(),
    agents: { currentInitiator() { return null } },
    // NOTE: llm / agentDefaultModel deliberately ABSENT — code must use
    // ctx.get('llm') which returns undefined and degrade gracefully.
  })
  const chainedCtx = { ctx, settings: SETTINGS, rawConfig: SETTINGS, config: SETTINGS, resolved: {}, keysForRedaction: [] }
  const probe = createProbe(ctx, SETTINGS)
  return { ctx, chainedCtx, probe, toolsCtx: { ctx, settings: SETTINGS, chainedCtx, web: {}, probe } }
}

test('web_doctor: runs under strict ctx (no ctx.session crash)', async () => {
  const { toolsCtx } = makeToolCtx()
  const tool = createWebDoctor(toolsCtx)
  const r = await tool.execute({}, { signal: { aborted: false } })
  assert.equal(r.severity, 'ok')
  assert.ok(Array.isArray(r.providers))
  // Passive probe must not have thrown the inject guard.
  assert.ok(r.identity, 'identity present')
})

test('probe.run active mode: no inject crash on identity/model reads', async () => {
  const { probe } = makeToolCtx()
  const r = await probe.run({ activeProbe: false })
  assert.equal(typeof r.severity, 'string')
})

test('web_search_ex: chain exhaustion (no keys) surfaces as structured error, not inject crash', async () => {
  const { toolsCtx } = makeToolCtx()
  const tool = createWebSearchEx(toolsCtx)
  await assert.rejects(
    tool.execute({ query: 'test', routing: 'auto' }, { signal: { aborted: false } }),
    (e) => e.code === 'WEB_SEARCH_CHAIN_EXHAUSTED' || e.code === 'PROVIDER_ERROR' || /exhausted/i.test(e.message),
  )
})

test('web_search_ex output=answer: degrades to sources when llm seam absent (no ctx.llm crash)', async () => {
  const { toolsCtx } = makeToolCtx()
  const tool = createWebSearchEx(toolsCtx)
  await assert.rejects(
    tool.execute({ query: 'test', output: 'answer' }, { signal: { aborted: false } }),
    (e) => !/cannot get property/.test(e.message),
  )
})

test('source_check: heuristic path under strict ctx (no ctx.llm / ctx.agentDefaultModel crash)', async () => {
  const { toolsCtx } = makeToolCtx()
  const tool = createSourceCheck(toolsCtx)
  const r = await tool.execute({ claim: 'test claim' }, { signal: { aborted: false } })
  assert.equal(r.claim, 'test claim')
  assert.ok(Array.isArray(r.subQueries) && r.subQueries.length >= 2)
  assert.ok(['supported', 'contradicted', 'mixed', 'insufficient'].includes(r.assessment))
})

test('search_content: missing cacheRef returns structured error (no inject crash)', async () => {
  const { toolsCtx } = makeToolCtx()
  const tool = createSearchContent(toolsCtx)
  await assert.rejects(
    tool.execute({ cacheRef: 'missing-ref' }, { signal: { aborted: false } }),
    (e) => e.code === 'WEB_CONTENT_NOT_FOUND' || e.code === 'WEB_CONTENT_EXPIRED' || /cache/i.test(e.message),
  )
})

test('skills: registration receives the full SkillRegistration contract', () => {
  const registered = []
  const skills = { register(def) { registered.push(def); return () => {} } }
  registerWebAccessSkill(makeStrictCtx({}), skills)
  registerWebAccessDoctorSkill(makeStrictCtx({}), skills)
  assert.equal(registered.length, 2)
  for (const def of registered) {
    assert.equal(typeof def.name, 'string')
    assert.equal(typeof def.description, 'string')
    assert.equal(typeof def.source, 'string')
    assert.equal(typeof def.content, 'string')
    assert.equal(def.body, undefined, 'body is not a seam field')
    assert.equal(def.triggers, undefined, 'triggers is not a seam field')
  }
})

test('/webdoctor-keys: runs against strict ctx + real-shaped credentials stub', async () => {
  const ctx = makeStrictCtx({ credentials: makeCredentialsStub() })
  const cmd = createKeysCmd({ ctx })
  const r = await cmd.execute({ subcommand: 'status' })
  assert.equal(r.ok, true)
  assert.equal(r.configured.length, 0)
  assert.ok(r.missing.length > 0)
})

test('lossless-JSON sanitizer: BigInt/undefined/functions/cycles never reach tool output', async () => {
  const { toLosslessJson } = await import('../../lib/util/lossless-json.js')
  const dirty = {
    n: 1n,
    u: undefined,
    f() {},
    nan: NaN,
    inf: Infinity,
    s: 'ok',
  }
  dirty.self = dirty
  const clean = toLosslessJson(dirty)
  assert.equal(clean.n, '1')
  assert.equal('u' in clean, false, 'undefined fields are dropped, not emitted')
  assert.equal('f' in clean, false, 'function fields are dropped, not emitted')
  assert.equal(clean.nan, null)
  assert.equal(clean.inf, null)
  assert.equal(clean.s, 'ok')
  assert.equal(clean.self, '<circular>')
  // Strict round-trip through JSON must now succeed.
  assert.doesNotThrow(() => JSON.stringify(clean))
})

test('defineTool shim: free-form object nodes are NOT compiled to empty strict shells (v2.2.1 lastPing fix)', async () => {
  // Regression lock for the live-host E2E finding: web_doctor activeProbe
  // output was rejected because the shim compiled `lastPing: { type: 'object' }`
  // into `{ type: 'object', additionalProperties: false }` (no properties),
  // so every inner field (status/latencyMs/httpStatus/reason) failed the host
  // validator as "not a declared property".
  const { defineTool } = await import('../../lib/schema/define-tool.js')
  const tool = defineTool({
    name: 'probe-fix-lock',
    description: 'x',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                lastPing: { type: 'object' },
              },
            },
          },
        },
      },
      render() { return [] },
    },
    async execute() { return null },
  })
  const lastPingNode = tool.output.schema.properties.providers.items.properties.lastPing
  assert.equal(lastPingNode.type, 'object')
  assert.equal(lastPingNode.additionalProperties, undefined,
    'free-form object must not gain additionalProperties:false — host would reject inner fields')
  // Declared-property objects must stay strict (existing v2.2 contract).
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(tool.output.schema.properties.providers.items.additionalProperties, false)
})

test('web_doctor schema: lastPing declares inner fields explicitly (v2.2.1)', async () => {
  const { OUTPUT } = await import('../../lib/tools/web-doctor.js')
  const lastPing = OUTPUT.schema.properties.providers.items.properties.lastPing
  assert.equal(lastPing.type, 'object')
  assert.equal(lastPing.additionalProperties, false)
  for (const k of ['status', 'reason', 'latencyMs', 'httpStatus']) {
    assert.ok(k in lastPing.properties, `lastPing.properties must declare ${k}`)
  }
})

test('web_search_ex: output schema no longer claims cacheRef (v2.2.1 honesty fix)', async () => {
  const { OUTPUT } = await import('../../lib/tools/web-search-ex.js')
  assert.equal('cacheRef' in OUTPUT.schema.properties, false,
    'web_search_ex never produces a cacheRef — the declaration misled models into calling search_content with fabricated refs')
  assert.ok('sources' in OUTPUT.schema.properties)
  assert.ok('provider' in OUTPUT.schema.properties)
})
