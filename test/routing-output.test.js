// test/routing-output.test.js — routing + output separation
// (SPEC §II.5 acceptance #17, no `mode`, no `reviewed-answer`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRouting } from '../lib/providers/search/chained.js'
import { PARAMETERS, OUTPUT } from '../lib/tools/web-search-ex.js'

test('selectRouting: undefined → auto', () => {
  assert.equal(selectRouting(undefined), 'auto')
  assert.equal(selectRouting(null), 'auto')
  assert.equal(selectRouting('auto'), 'auto')
})

test('selectRouting: aggregate', () => {
  assert.equal(selectRouting('aggregate'), 'aggregate')
})

test('selectRouting: single id', () => {
  assert.deepEqual(selectRouting('brave'), { kind: 'single', id: 'brave' })
})

test('selectRouting: ordered list', () => {
  assert.deepEqual(selectRouting(['exa', 'brave', 'tavily']), { kind: 'ordered', ids: ['exa', 'brave', 'tavily'] })
})

test('selectRouting: empty list → BAD_REQUEST (strict, was silently auto in v2.2)', () => {
  // v2.3.0: an explicitly supplied empty list is ambiguous. The router
  // raises WEB_PROVIDER_BAD_REQUEST instead of silently degrading to
  // 'auto' (which the v2.2 behaviour did and is the review P0 #1
  // symptom).
  assert.throws(() => selectRouting([]), (err) => err && err.code === 'WEB_PROVIDER_BAD_REQUEST')
})

test('selectRouting: garbage → BAD_REQUEST (strict, was silently auto in v2.2)', () => {
  assert.throws(() => selectRouting({}), (err) => err && err.code === 'WEB_PROVIDER_BAD_REQUEST')
  assert.throws(() => selectRouting(42), (err) => err && err.code === 'WEB_PROVIDER_BAD_REQUEST')
})

test('normaliseRouting accepts array of provider ids (P0 #8)', () => {
  // The Tool's normaliseRouting is internal; this asserts the contract
  // selectRouting consumes.
  assert.deepEqual(selectRouting(['brave', 'exa']), { kind: 'ordered', ids: ['brave', 'exa'] })
  assert.deepEqual(selectRouting(['brave']), { kind: 'single', id: 'brave' })
  // v2.3.0: explicit empty array is rejected, NOT silently auto.
  assert.throws(() => selectRouting([]), (err) => err && err.code === 'WEB_PROVIDER_BAD_REQUEST')
})

test('web_search_ex PARAMETERS: routing is a union (string OR array of strings)', () => {
  // P0 #8: routing accepts a string OR array of strings per SPEC §I.4 #17.
  // v2.2: the host rejects `type: 'json'` in tool schemas, so the union is
  // declared as oneOf: [string, array] and execute() additionally validates
  // via normaliseRouting().
  assert.ok(PARAMETERS.routing, 'routing parameter declared')
  assert.equal(PARAMETERS.routing.type, undefined, 'no type:json (host-invalid)')
  assert.ok(Array.isArray(PARAMETERS.routing.oneOf) && PARAMETERS.routing.oneOf.length === 2,
    'routing is oneOf: [string, array]')
})

test('web_search_ex PARAMETERS: output is "sources" | "answer" (no reviewed-answer)', () => {
  assert.deepEqual(PARAMETERS.output.enum, ['sources', 'answer'])
})

test('web_search_ex PARAMETERS: NO "mode" parameter (v1 had mode=sources-only/answer/both)', () => {
  assert.equal(PARAMETERS.mode, undefined, 'mode parameter must be removed in v2.0')
})

test('web_search_ex PARAMETERS: NO "provider" parameter (replaced by routing)', () => {
  // v1 had `provider: 'auto' | 'all' | <name>`; v2.0 uses `routing`.
  assert.equal(PARAMETERS.provider, undefined, 'provider parameter replaced by routing in v2.0')
})

// ── Defect C: the serving provider must be visible in the output ──────
//
// 2026-09-11, main instance: `web_search_ex(routing="auto")` rendered
// answer + sources only. The `provider` field was already in the
// structured value (schema §provider), but with nothing rendering it the
// only way to learn which provider served a call was to re-run the same
// query pinned to one provider and compare.

const { render } = OUTPUT

test('web_search_ex render: prints the serving provider before the sources', () => {
  const blocks = render({}, {
    provider: 'aggregate',
    sources: [{ url: 'https://example.com/a', title: 'A' }],
  })
  assert.equal(blocks[0].type, 'text')
  // Trailing newline is required: the host concatenates blocks verbatim,
  // so without it the id glues to the first source URL.
  assert.equal(blocks[0].text, 'provider: aggregate\n')
  const srcIndex = blocks.findIndex((b) => /example\.com/.test(b.text))
  assert.ok(srcIndex > 0, 'provider line precedes the sources')
})

test('web_search_ex render: omits the provider line when the value has none', () => {
  const blocks = render({}, { sources: [{ url: 'https://example.com/a' }] })
  assert.ok(!blocks.some((b) => /^provider:/.test(b.text)))
})

test('web_search_ex render: caps the provider-error wall but keeps the count', () => {
  const providerErrors = Array.from({ length: 30 }, (_, i) => ({ provider: `p${i}`, error: 'X_API_KEY:credential' }))
  const blocks = render({}, { provider: 'aggregate', sources: [], providerErrors })
  const errBlock = blocks.find((b) => b.text.includes('## Provider errors'))
  assert.ok(errBlock, 'errors are still reported')
  assert.equal(errBlock.text.split('\n').filter((l) => l.startsWith('- ')).length, 13, '12 lines + the count line')
  assert.match(errBlock.text, /and 18 more/)
})
