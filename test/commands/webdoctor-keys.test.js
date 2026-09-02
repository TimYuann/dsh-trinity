// test/commands/webdoctor-keys.test.js — /webdoctor-keys slash command
// (v2.2; SPEC §0.3). Covers list / status / set / clear / test / help
// with a stub DSH credentials service. Confirms:
//   1. `list` returns every provider slot with presence/state
//   2. `status` reports configured vs missing + onboarding hints
//   3. `set` invokes credentials.set(ref, value) with the env-name ref
//      and redacts the value in the response (only last-4 fingerprint)
//   4. `clear` invokes credentials.unset(ref)
//   5. `test` reports presence + source from describe() without leaking
//      the value
//   6. `help` returns the usage text
//   7. validation: empty key + placeholder key are rejected
//   8. validation: unknown provider is rejected

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommand } from '../../lib/commands/webdoctor-keys.js'
import { ALL_PROVIDER_IDS } from '../../lib/config-schema.js'
import { providerCredentialRef, providerIdToEnvName } from '../../lib/credentials/resolve.js'

/**
 * Build a stub DSH credentials service that records every call and
 * returns a canned resolve/describe response per provider.
 *
 * v2.2: the seam takes plain env-name ref strings (EXA_API_KEY) — the
 * stub mirrors that (no `{ key: ... }` objects).
 *
 * @param {object} [opts]
 * @param {Record<string, { value?: string, source?: string }>} [opts.stored]
 *        Map of providerId → stored value + source for the `describe`/`resolve` seams.
 */
function makeStubCredentials(opts = {}) {
  const stored = opts.stored || {}
  const sets = []
  const unsets = []
  /** @param {string} ref */
  function providerFromRef(ref) {
    if (typeof ref !== 'string') return null
    for (const p of ALL_PROVIDER_IDS) {
      const base = providerIdToEnvName(p)
      if (ref === base || ref.startsWith(base + '_')) return p
    }
    return null
  }
  return {
    state: { sets, unsets },
    async resolve(ref) {
      const provider = providerFromRef(ref)
      if (!provider) return null
      const rec = stored[provider]
      if (!rec || !rec.value) return null
      return { value: rec.value, source: rec.source || 'credentials' }
    },
    async describe(ref) {
      const provider = providerFromRef(ref)
      if (!provider) return { configured: false, writable: true }
      const rec = stored[provider]
      if (!rec || !rec.value) return { configured: false, writable: true }
      return { configured: true, source: rec.source || 'credentials', writable: true }
    },
    async set(ref, value) {
      sets.push({ key: ref, value })
      if (typeof value !== 'string' || value.length === 0) {
        const e = new Error('empty value rejected')
        e.code = 'EMPTY_VALUE'
        throw e
      }
      // Mirror DSH's post-set behaviour: subsequent resolve() must see
      // the freshly written value. The production code relies on this to
      // compute the last-4 fingerprint for `set` confirmation.
      const provider = providerFromRef(ref)
      if (provider) stored[provider] = { value, source: 'credentials' }
    },
    async unset(ref) {
      unsets.push({ key: ref })
      const provider = providerFromRef(ref)
      if (provider) delete stored[provider]
    },
  }
}

function makeCtx(credentials) {
  return {
    get(key) {
      if (key === 'credentials') return credentials
      return null
    },
  }
}

test('help: returns usage text and never touches the credentials seam', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'help' })
  assert.equal(r.ok, true)
  assert.match(r.message, /Usage/i)
  assert.match(r.message, /list/)
  assert.match(r.message, /set/)
  assert.match(r.message, /clear/)
  assert.match(r.message, /test/)
  assert.equal(credentials.state.sets.length, 0)
  assert.equal(credentials.state.unsets.length, 0)
})

test('list: reports every provider slot (UNSET by default)', async () => {
  const credentials = makeStubCredentials({ stored: { exa: { value: 'example-credential-aaaa1234', source: 'credentials' } } })
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'list' })
  assert.equal(r.ok, true)
  // v2.2: 3 slots per provider (slot 1 + rotation slots 2-3).
  assert.equal(r.rows.length, ALL_PROVIDER_IDS.length * 3)
  // exa slot 1 is stored; should be SET with last-4
  const exaRow = r.rows.find((row) => row.provider === 'exa' && row.slot === 1)
  assert.equal(exaRow.presence, 'SET')
  assert.equal(exaRow.last4, '1234')
  assert.equal(exaRow.ref, 'EXA_API_KEY')
  // A representative unset row
  const braveRow = r.rows.find((row) => row.provider === 'brave' && row.slot === 1)
  assert.equal(braveRow.presence, 'UNSET')
})

test('status: onboarding view — configured vs missing + exact fix commands', async () => {
  const credentials = makeStubCredentials({ stored: { exa: { value: 'example-credential-aaaa1234', source: 'credentials' } } })
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'status' })
  assert.equal(r.ok, true)
  assert.equal(r.summary.includes('1 with a configured key'), true)
  assert.equal(r.missing.some((m) => m.provider === 'gemini'), true)
  assert.match(r.hint, /\/webdoctor-keys set \w+ <your-key>/)
  assert.equal(r.missing.some((m) => m.provider === 'exa'), false)
  const serialised = JSON.stringify(r)
  assert.equal(serialised.includes('example-credential-aaaa1234'), false,
    'status must never echo stored values')
})

test('set: writes the credential + returns only the last-4 fingerprint', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'set', provider: 'exa', key: 'example-credential-deadbeef' })
  assert.equal(r.ok, true)
  assert.equal(credentials.state.sets.length, 1)
  assert.equal(credentials.state.sets[0].key, 'EXA_API_KEY')
  assert.equal(credentials.state.sets[0].value, 'example-credential-deadbeef')
  // Message must include the fingerprint and NEVER the full key
  assert.match(r.message, /last-4: beef/)
  assert.equal(r.message.includes('example-credential-deadbeef'), false,
    'set response must not echo the full key value')
})

test('set: rejects empty key with EMPTY_KEY code', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'set', provider: 'exa', key: '' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EMPTY_KEY')
  assert.equal(credentials.state.sets.length, 0)
})

test('set: rejects placeholder key with PLACEHOLDER_KEY code', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  for (const placeholder of ['your-key', 'changeme', 'replace-me']) {
    const r = await cmd.execute({ subcommand: 'set', provider: 'exa', key: placeholder })
    assert.equal(r.ok, false, `placeholder "${placeholder}" should be rejected`)
    assert.equal(r.code, 'PLACEHOLDER_KEY')
  }
  assert.equal(credentials.state.sets.length, 0)
})

test('set: unknown provider is rejected (UNKNOWN_PROVIDER)', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'set', provider: 'nope', key: 'sk-x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNKNOWN_PROVIDER')
  assert.equal(credentials.state.sets.length, 0)
})

test('clear: invokes credentials.unset for the matching ref', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'clear', provider: 'brave' })
  assert.equal(r.ok, true)
  assert.equal(credentials.state.unsets.length, 1)
  assert.equal(credentials.state.unsets[0].key, 'BRAVE_API_KEY')
  assert.match(r.message, /brave key cleared/)
})

test('clear: unknown provider is rejected', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'clear', provider: 'mystery' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNKNOWN_PROVIDER')
  assert.equal(credentials.state.unsets.length, 0)
})

test('test: reports presence + source for a stored credential', async () => {
  const credentials = makeStubCredentials({ stored: { tavily: { value: 'tv-5555', source: 'env' } } })
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'test', provider: 'tavily' })
  assert.equal(r.ok, true)
  // v2.2: presence is the configured flag; source reports the layer.
  assert.equal(r.presence, 'SET')
  assert.equal(r.source, 'env')
  // The value must NOT appear anywhere in the response.
  const serialised = JSON.stringify(r)
  assert.equal(serialised.includes('tv-5555'), false,
    'test response must never echo the stored value')
})

test('test: UNSET when no credential stored (and no env var)', async () => {
  const credentials = makeStubCredentials({})
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  delete process.env.BRAVE_API_KEY  // ensure no leftover
  const r = await cmd.execute({ subcommand: 'test', provider: 'brave' })
  assert.equal(r.ok, true)
  assert.equal(r.presence, 'UNSET')
})

test('parses free-form string args (`raw` / `input` field)', async () => {
  const credentials = makeStubCredentials()
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  // Simulate DSH invoking with a raw string instead of structured args
  const r = await cmd.execute({ raw: 'set exa example-credential-12345678' })
  assert.equal(r.ok, true)
  assert.equal(credentials.state.sets[0].value, 'example-credential-12345678')
  assert.match(r.message, /last-4: 5678/)
})

test('gracefully fails when ctx is unavailable', async () => {
  const cmd = createCommand({})  // no ctx
  const r = await cmd.execute({ subcommand: 'list' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_CTX')
})

test('gracefully fails when credentials service is missing', async () => {
  const ctx = { get: () => null }  // get returns null for everything
  const cmd = createCommand({ ctx })
  const r = await cmd.execute({ subcommand: 'list' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_CREDENTIALS')
})

test('NEVER echoes full API keys in any path', async () => {
  const credentials = makeStubCredentials({
    stored: {
      brave: { value: 'example-credential-brave-9X8Y', source: 'credentials' },
      gemini: { value: 'example-credential-gemini-XYZ', source: 'env' },
    },
  })
  const ctx = makeCtx(credentials)
  const cmd = createCommand({ ctx })
  const responses = []
  responses.push(await cmd.execute({ subcommand: 'list' }))
  responses.push(await cmd.execute({ subcommand: 'test', provider: 'brave' }))
  responses.push(await cmd.execute({ subcommand: 'test', provider: 'gemini' }))
  responses.push(await cmd.execute({ subcommand: 'set', provider: 'exa', key: 'example-credential-exa-1234AB' }))
  for (const r of responses) {
    const text = JSON.stringify(r)
    assert.equal(text.includes('example-credential-brave-9X8Y'), false,
      'must not leak the stored brave key anywhere')
    assert.equal(text.includes('example-credential-gemini-XYZ'), false,
      'must not leak the stored gemini key anywhere')
    // Freshly-set key may appear ONLY in the credentials.set call's
    // record (which is internal state), not in any user-facing result
    // except the last-4 fingerprint ("1234AB".slice(-4) === "34AB").
    const appearanceIdx = text.indexOf('example-credential-exa-1234AB')
    if (appearanceIdx >= 0) {
      assert.fail('full set key leaked into the response: ' + text)
    }
  }
})
