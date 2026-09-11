// test/iso8601.test.js — host-timezone invariance for date normalisation.
//
// Why this file exists (2026-09-12): CI had been red since 2026-09-04 while
// every local run was green. The single failure was
//
//   test/chained.search.test.js — "shapeResult normalises ISO-8601 …"
//   actual:   '2026-02-04T23:39:58.000Z'
//   expected: '2026-02-04T15:39:58.000Z'
//
// `toIso8601('2026-02-04 23:39:58')` handed a zone-less timestamp to the
// platform parser, and ECMAScript reads a date-and-time with no offset in
// the HOST's zone. The expectation only held on Asia/Shanghai; a UTC
// runner disagreed by eight hours. Twenty-two provider modules call
// toIso8601, so the same provider response produced a different instant
// depending on where the search ran.
//
// The unit assertions below run in-process, so on their own they cannot
// catch a regression that depends on the ambient zone. The last case is
// the actual guard: it re-runs the conversion in child processes under
// several TZ values and requires identical output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { toIso8601, isValidIso8601 } from '../lib/iso8601.js'

const MODULE = new URL('../lib/iso8601.js', import.meta.url).href

test('toIso8601: a zone-less timestamp is pinned to UTC', () => {
  // Both separators, and the space form the providers actually emit.
  assert.equal(toIso8601('2026-02-04 23:39:58'), '2026-02-04T23:39:58.000Z')
  assert.equal(toIso8601('2026-02-04T23:39:58'), '2026-02-04T23:39:58.000Z')
})

test('toIso8601: an explicit designator is honoured, not overridden', () => {
  assert.equal(toIso8601('2026-02-04 23:39:58+08:00'), '2026-02-04T15:39:58.000Z')
  assert.equal(toIso8601('2026-02-04T23:39:58+08:00'), '2026-02-04T15:39:58.000Z')
  assert.equal(toIso8601('2026-02-04T23:39:58Z'), '2026-02-04T23:39:58.000Z')
  // Compact offset form (+0800) is legal in ISO-8601 too.
  assert.equal(toIso8601('2026-02-04T23:39:58+0800'), '2026-02-04T15:39:58.000Z')
})

test('toIso8601: fractional seconds parse with either decimal separator', () => {
  assert.equal(toIso8601('2026-02-04T23:39:58.500Z'), '2026-02-04T23:39:58.500Z')
  assert.equal(toIso8601('2026-02-04 23:39:58.500'), '2026-02-04T23:39:58.500Z')
  // A comma is a legal separator in several locales and providers emit it;
  // the previous implementation returned undefined for this input.
  assert.equal(toIso8601('2026-02-04 23:39:58,123'), '2026-02-04T23:39:58.123Z')
})

test('toIso8601: unparseable input yields undefined rather than throwing', () => {
  assert.equal(toIso8601('not a date'), undefined)
  assert.equal(toIso8601(''), undefined)
  assert.equal(toIso8601(null), undefined)
  assert.equal(toIso8601(undefined), undefined)
  assert.equal(toIso8601({}), undefined)
})

test('toIso8601: Date and numeric inputs still work', () => {
  assert.equal(toIso8601(new Date('2026-02-04T23:39:58Z')), '2026-02-04T23:39:58.000Z')
  assert.equal(toIso8601(new Date(NaN)), undefined)
  assert.equal(toIso8601(0), '1970-01-01T00:00:00.000Z')
})

test('isValidIso8601: rejects the space form and accepts the T form', () => {
  assert.equal(isValidIso8601('2026-02-04T23:39:58.000Z'), true)
  assert.equal(isValidIso8601('2026-02-04 23:39:58'), false)
  assert.equal(isValidIso8601('garbage'), false)
  assert.equal(isValidIso8601(null), false)
})

// ─────────────────────────────────────────────────────────────────────
// The guard: identical output under different host timezones
// ─────────────────────────────────────────────────────────────────────

/** Convert `input` in a child node process running under `tz`. */
function convertInZone(tz, input) {
  const r = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { toIso8601 } from ${JSON.stringify(MODULE)}; process.stdout.write(String(toIso8601(${JSON.stringify(input)})))`,
  ], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
  assert.equal(r.status, 0, `child under TZ=${tz} failed: ${r.stderr}`)
  return r.stdout
}

test('toIso8601: output does not depend on the host timezone', () => {
  // Zones chosen to bracket the range: UTC+14 has the largest positive
  // offset in the tz database, UTC-11 the largest negative.
  const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Midway']
  for (const input of ['2026-02-04 23:39:58', '2026-02-04T23:39:58']) {
    const seen = zones.map((tz) => convertInZone(tz, input))
    const unique = [...new Set(seen)]
    assert.equal(unique.length, 1,
      `${input} produced ${unique.length} different instants across ${zones.length} zones: ${JSON.stringify(seen)}`)
    assert.equal(unique[0], '2026-02-04T23:39:58.000Z')
  }
})

test('toIso8601: an explicit offset is zone-independent too', () => {
  const zones = ['UTC', 'Asia/Shanghai', 'America/New_York']
  const seen = zones.map((tz) => convertInZone(tz, '2026-02-04 23:39:58+08:00'))
  assert.deepEqual([...new Set(seen)], ['2026-02-04T15:39:58.000Z'])
})
