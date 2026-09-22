// test/provider-error-attribution.test.js — the chain must not report
// empty-credential-slot noise as the provider's failure.
//
// REGRESSION (2026-09-22, DSH 0.1.7-alpha.1):
//   A provider whose single real key fails for a NON-credential reason
//   still walks its two empty slots afterwards. Each empty slot throws
//   MISSING_API_KEY (class `credential`), and the single-provider branch
//   reported the LAST attempt — so the model was told its (valid) key was
//   bad. This is what turned the Exa gzip-decode bug and the retired
//   Gemini model into convincing-looking credential errors.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chainedSearch, PROVIDER_REGISTRY } from '../lib/providers/search/chained.js'

/** ctx with exactly one resolvable credential slot. */
function ctxWithOneKey(providerId, ref) {
  return {
    ctx: {
      get(name) {
        if (name !== 'credentials') return undefined
        return {
          async resolve(r) {
            return r === ref ? { value: 'test-key-not-a-real-secret', source: 'test' } : undefined
          },
        }
      },
    },
    rawConfig: {},
    config: { mmxFallback: false },
    keysForRedaction: ['test-key-not-a-real-secret'],
  }
}

test('REGRESSION: a real provider failure is not masked by empty-slot credential noise', async () => {
  // A provider entry is an ESM namespace, so its properties are read-only:
  // swap the whole registry entry and put the original object back after.
  const original = PROVIDER_REGISTRY.exa
  // Slot 1 gets the key and fails on the RESPONSE, not on the key.
  PROVIDER_REGISTRY.exa = {
    ...original,
    providerSearch: async () => { throw new Error('invalid json in provider response') },
  }
  try {
    await assert.rejects(
      chainedSearch({ query: 'x', routing: 'exa' }, undefined, ctxWithOneKey('exa', 'EXA_API_KEY')),
      (err) => {
        // The whole point: the message must describe the REAL failure.
        assert.match(err.message, /invalid-response/)
        assert.doesNotMatch(err.message, /credential/)
        // The full attempt trail is still exposed for the doctor.
        assert.ok(Array.isArray(err.attempts) && err.attempts.length >= 2)
        assert.equal(err.attempts[0].class, 'invalid-response')
        return true
      },
    )
  } finally {
    PROVIDER_REGISTRY.exa = original
  }
})

test('credential is still reported when no slot has a key at all', async () => {
  const original = PROVIDER_REGISTRY.exa
  PROVIDER_REGISTRY.exa = {
    ...original,
    providerSearch: async (_q, _n, apiKey) => {
      if (!apiKey) throw new Error('missing api key')
      throw new Error('unexpected')
    },
  }
  try {
    await assert.rejects(
      chainedSearch({ query: 'x', routing: 'exa' }, undefined, {
        ctx: { get: () => ({ resolve: async () => undefined }) },
        rawConfig: {},
        config: { mmxFallback: false },
        keysForRedaction: [],
      }),
      (err) => {
        // Every attempt lacked a key: `credential` IS the honest answer here.
        assert.match(err.message, /credential/)
        return true
      },
    )
  } finally {
    PROVIDER_REGISTRY.exa = original
  }
})
