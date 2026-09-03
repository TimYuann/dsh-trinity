// test/credentials/web-ui-validation.test.js — Browser-side validation
// surface for the v2.2.3 Web UI Provider Key Settings card. Shared with
// the slash command (`/webdoctor-keys`) so two validators cannot drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_PROVIDER_IDS,
  isValidProvider,
  validateKeyValue,
  validateRef,
  envNameForProvider,
  clientLast4,
} from '../../lib/credentials/web-ui-validation.js'

test('isValidProvider: accepts every provider in ALL_PROVIDER_IDS', () => {
  for (const id of ALL_PROVIDER_IDS) {
    assert.equal(isValidProvider(id), true, `expected ${id} to be valid`)
  }
})

test('isValidProvider: rejects unknown, empty, non-string', () => {
  for (const id of ['', 'unknown', null, undefined, 42, {}, 'EXA_API_KEY', '__proto__']) {
    assert.equal(isValidProvider(id), false, `expected ${JSON.stringify(id)} to be rejected`)
  }
})

test('validateKeyValue: accepts a realistic key', () => {
  const r = validateKeyValue('example-credential-1234567890abcdef')
  assert.equal(r.ok, true)
  assert.equal(r.value, 'example-credential-1234567890abcdef')
})

test('validateKeyValue: rejects empty / whitespace-only', () => {
  for (const v of ['', '   ', '\t\n', '\n']) {
    const r = validateKeyValue(v)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'empty')
  }
})

test('validateKeyValue: rejects non-string', () => {
  for (const v of [null, undefined, 42, {}, [], true]) {
    const r = validateKeyValue(v)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad-shape')
  }
})

test('validateKeyValue: rejects placeholder tokens (case-insensitive)', () => {
  for (const v of ['your-key', 'YOUR-KEY', 'xxx', 'XXX', 'placeholder', 'changeme', 'null', 'undefined', 'fixme', 'todo']) {
    const r = validateKeyValue(v)
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be rejected as placeholder`)
    assert.equal(r.code, 'placeholder')
  }
})

test('validateKeyValue: rejects too-short values', () => {
  for (const v of ['abc', 'abcdefg', '1234567']) {
    const r = validateKeyValue(v)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'too-short')
  }
})

test('validateKeyValue: error messages do NOT echo the value', () => {
  const r2 = validateKeyValue('your-key')
  assert.equal(r2.ok, false)
  assert.equal(r2.message.includes('your-key'), false)
  const r3 = validateKeyValue('abc')
  assert.equal(r3.ok, false)
  assert.equal(r3.message.includes('abc'), false)
})

test('validateRef: accepts POSIX env names', () => {
  for (const v of ['EXA_API_KEY', 'EXA_API_KEY_2', '_PRIVATE', 'A1']) {
    const r = validateRef(v)
    assert.equal(r.ok, true)
  }
})

test('validateRef: rejects non-string and bad shape', () => {
  for (const v of ['', null, undefined, 42, 'EXA-API-KEY', '1EXA', 'EXA API KEY', 'EXA.API.KEY']) {
    const r = validateRef(v)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad-shape')
  }
})

test('envNameForProvider: maps every provider to a string', () => {
  for (const id of ALL_PROVIDER_IDS) {
    const envName = envNameForProvider(id)
    assert.equal(typeof envName, 'string')
    assert.ok(envName.length > 0)
  }
})

test('envNameForProvider: searxng maps to SEARXNG_HOST', () => {
  assert.equal(envNameForProvider('searxng'), 'SEARXNG_HOST')
})

test('clientLast4: returns trailing 4 chars for values >= 8 chars', () => {
  assert.equal(clientLast4('example-credential-1234567890abcdef'), 'cdef')
  assert.equal(clientLast4('12345678'), '5678')
})

test('clientLast4: returns null for short / placeholder / non-string', () => {
  for (const v of [null, undefined, '', 'abc', '1234567', '  ', 'your-key', 'changeme']) {
    assert.equal(clientLast4(v), null, `expected ${JSON.stringify(v)} to yield null last4`)
  }
})