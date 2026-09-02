// test/routing-output.test.js — routing + output separation
// (SPEC §II.5 acceptance #17, no `mode`, no `reviewed-answer`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRouting } from '../lib/providers/search/chained.js'
import { PARAMETERS } from '../lib/tools/web-search-ex.js'

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

test('selectRouting: empty list → auto', () => {
  assert.equal(selectRouting([]), 'auto')
})

test('selectRouting: garbage → auto', () => {
  assert.equal(selectRouting({}), 'auto')
  assert.equal(selectRouting(42), 'auto')
})

test('normaliseRouting accepts array of provider ids (P0 #8)', () => {
  // The Tool's normaliseRouting is internal; this asserts the contract
  // selectRouting consumes.
  assert.deepEqual(selectRouting(['brave', 'exa']), { kind: 'ordered', ids: ['brave', 'exa'] })
  assert.deepEqual(selectRouting(['brave']), { kind: 'single', id: 'brave' })
  assert.deepEqual(selectRouting([]), 'auto')
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
