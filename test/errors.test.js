// test/errors.test.js — contract assertions on lib/errors.js (MANUAL §13.0)
//
// These tests assert that the central toolError() helper produces the
// canonical 3-part message and structured fields, and that
// wrapProviderError() never renders the [object Object] trap that breaks
// the LLM-visible error contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Import the helper
import { toolError, httpStatusToCode, wrapProviderError, TOOL_ERROR_CODES } from '../lib/errors.js'

// Test 1: toolError produces canonical 3-part message
test('toolError produces [tool] WHAT | CODE: x | TRY: advice format', () => {
  const e = toolError('web_search_ex', 'MISSING_API_KEY', 'no exa key', 'set EXA_API_KEY or use brave')
  assert.match(e.message, /^\[web_search_ex\] no exa key \| CODE: MISSING_API_KEY \| TRY: set EXA_API_KEY or use brave$/)
  assert.equal(e.tool, 'web_search_ex')
  assert.equal(e.code, 'MISSING_API_KEY')
  assert.equal(e.advice, 'set EXA_API_KEY or use brave')
  assert.ok(e instanceof Error)
})

// Test 2: httpStatusToCode covers the standard set
test('httpStatusToCode maps status to standard codes', () => {
  assert.equal(httpStatusToCode(400).code, 'HTTP_400')
  assert.equal(httpStatusToCode(401).code, 'HTTP_401')
  assert.equal(httpStatusToCode(403).code, 'HTTP_403')
  assert.equal(httpStatusToCode(404).code, 'HTTP_404')
  assert.equal(httpStatusToCode(429).code, 'HTTP_429')
  assert.equal(httpStatusToCode(500).code, 'HTTP_5XX')
  assert.equal(httpStatusToCode(503).code, 'HTTP_5XX')
  assert.equal(httpStatusToCode(418).code, 'HTTP_418')  // unknown → custom
})

// Test 3: wrapProviderError never produces '[object Object]'
test('wrapProviderError never stringifies to [object Object]', () => {
  const weird = new Error()
  weird.message = { foo: 'bar' }   // object as message
  const wrapped = wrapProviderError('exa', weird, 'switch provider')
  assert.ok(!wrapped.message.includes('[object Object]'))
  assert.match(wrapped.message, /\[exa\]/)
  assert.equal(wrapped.code, 'PROVIDER_ERROR')

  const nonError = { random: 'object' }
  const wrapped2 = wrapProviderError('brave', nonError, 'try anysearch')
  assert.ok(!wrapped2.message.includes('[object Object]'))
  assert.match(wrapped2.message, /\[brave\]/)
})

// Test 4: every code in TOOL_ERROR_CODES is a non-empty string
test('TOOL_ERROR_CODES registry is well-formed', () => {
  for (const [k, v] of Object.entries(TOOL_ERROR_CODES)) {
    assert.equal(typeof v, 'string')
    assert.ok(v.length > 0)
    // Convention: code keys are SCREAMING_SNAKE_CASE
    assert.match(k, /^[A-Z][A-Z0-9_]*$/)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Tool error contract (MANUAL §13.0): representative paths through each Tool
// must produce a 3-part message of the form `[<tool>] WHAT | CODE: <code> | TRY: <advice>`,
// and the structured fields (err.tool / err.code / err.advice) must be set so
// log redaction / telemetry can read them without parsing the message.
// ──────────────────────────────────────────────────────────────────────────

// Reusable matcher for the canonical 3-part shape
const THREE_PART_RE = /^\[[^\]]+\][^|]*\| CODE: [A-Z0-9_]+ \| TRY: .+$/
function assertThreePart(err, expectedTool) {
  assert.ok(err instanceof Error, 'instanceof Error')
  assert.match(err.message, THREE_PART_RE, `message does not match 3-part format: ${err.message}`)
  assert.equal(err.tool, expectedTool, `err.tool mismatch: ${err.tool}`)
  assert.equal(typeof err.code, 'string', 'err.code is string')
  assert.ok(err.code.length > 0, 'err.code is non-empty')
  assert.equal(typeof err.advice, 'string', 'err.advice is string')
  assert.ok(err.advice.length > 0, 'err.advice is non-empty')
}

test('web_search_ex empty query produces 3-part error', async () => {
  // Note: query is declared required:true, so DSH's defineTool wrapper
  // throws ToolArgsError BEFORE our toolError runs. That path is covered
  // by the existing tool smoke test. This test exercises the
  // queries=[] / query='' path which reaches our WEB_PROVIDER_BAD_REQUEST.
  const { createTool } = await import('../lib/tools/web-search-ex.js')
  const def = createTool({ ctx: stubCtx() })
  try {
    // Provide a non-empty `query` arg so defineTool validation passes,
    // then strip it inside the tool: passing an empty string keeps the
    // required-key check happy while still reaching our handler.
    await def.execute({ query: '' }, { signal: new AbortController().signal })
    assert.fail('expected throw')
  } catch (e) { assertThreePart(e, 'web_search_ex') }
})

test('retired v1.0 tools are NOT registered (page_extract / web_fetch_ex / gemini_* / youtube_extract)', async () => {
  // SPEC §I.5: these tools are folded into web_fetch / web_search_ex in v2.0.
  const fs = await import('node:fs')
  for (const retired of ['page-extract', 'web-fetch-ex', 'gemini-search', 'gemini-url-context', 'youtube-extract']) {
    assert.throws(
      () => fs.readFileSync(new URL(`../lib/tools/${retired}.js`, import.meta.url)),
      undefined,
      `retired tool ${retired} must not exist in v2.0`,
    )
  }
})

// (Retired v1 tool error-contract tests deleted alongside their modules.)

// Minimal stub ctx for the contract tests — most error paths short-circuit
// before touching creds, so the full stub isn't required.
function stubCtx(overrides = {}) {
  return {
    creds: {
      resolved: {},
      rawConfig: {},
      ssrf: { allowRanges: [], trustEnvProxy: false },
      domainPolicy: { allow: [], deny: [] },
      pdf: { enabled: true, maxSizeMB: 20, provider: 'unpdf' },
      githubClone: { enabled: true, maxRepoSizeMB: 350, cloneTimeoutSeconds: 30, clonePath: '/tmp/dsh-github-repos' },
      youtube: { enabled: true, preferredModel: 'gemini-2.5-flash' },
      video: { enabled: true, preferredModel: 'gemini-2.5-flash', maxSizeMB: 50, allowedRoots: ['/tmp'] },
      fetchRouting: { providers: ['http'], allowRemoteHostedProviders: false },
      keysForRedaction: [],
      ...overrides,
    },
    config: {
      searchProviderOrder: 'auto',
      searchFallbackOn: ['transient', 'quota', 'network', 'invalid-response'],
      perStepTimeoutMs: 15000,
      fetchRoutingMode: 'http-only',
      ssrf: { allowRanges: [], trustEnvProxy: false },
      fetchMaxResponseMB: 5,
      tools: { all_tools: true },
      mmxFallback: true,
    },
  }
}
