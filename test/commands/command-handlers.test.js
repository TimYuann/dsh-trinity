// test/commands/command-handlers.test.js — the DSH slash-command contract for
// the three commands this bundle registers (/webdoctor, /webcache,
// /webdoctor-keys).
//
// Regression under test: v2.3.0-rc.2 defined only `execute(args)`. DSH's
// `ctx.commands.register()` runs every definition through
// `normalizeDefinition()` (verified against the published
// `@deepseek-ai/dsh-commands@0.1.5-rc.2` and `@0.1.6-alpha.1`), which throws
// `command "<name>" handler must be a function` without a `handler`, and
// `normalizeResult()` requires `{ kind: 'success' | 'error', text? }`. Both
// made registration throw for all three commands — visible in the live host as
// three `web-access-chain.apply { phase: 'commands.*' }` warnings per boot and
// three commands that never existed.
//
// These tests pin:
//   1. every definition satisfies the registration checks;
//   2. every handler returns a well-formed CommandResult;
//   3. `invocation.rawInput` (which keeps its leading separator space) parses;
//   4. no rendered result ever echoes a stored credential value.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommand as createWebDoctor } from '../../lib/commands/webdoctor.js'
import { createCommand as createWebCache } from '../../lib/commands/webcache.js'
import { createCommand as createWebDoctorKeys } from '../../lib/commands/webdoctor-keys.js'
import { put } from '../../lib/cache/index.js'
import { ALL_PROVIDER_IDS } from '../../lib/config-schema.js'
import { providerIdToEnvName } from '../../lib/credentials/resolve.js'

// ── DSH contract mirror ──────────────────────────────────────────────
// Copied from dsh-commands/lib/index.js (rc.2 + alpha.1 agree on all of it).

const DSH_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** normalizeDefinition()'s rejection rules, in the same order. */
function assertDshRegisterable(definition) {
  assert.equal(typeof definition.name, 'string', 'name must be a string')
  assert.match(definition.name, DSH_COMMAND_NAME, `command name "${definition.name}" must match ${String(DSH_COMMAND_NAME)}`)
  assert.equal(typeof definition.description, 'string', `command "${definition.name}" description must be a string`)
  assert.ok(definition.description.trim().length > 0, `command "${definition.name}" description must not be empty`)
  assert.equal(typeof definition.handler, 'function', `command "${definition.name}" handler must be a function`)
}

/** normalizeResult()'s acceptance rules. */
function assertDshResult(result, name) {
  assert.ok(result && typeof result === 'object', `command "${name}" handler must return a CommandResult`)
  assert.ok('kind' in result, `command "${name}" result must be discriminated`)
  if (result.kind === 'success') {
    assert.ok(result.text === undefined || typeof result.text === 'string', 'success text must be a string when supplied')
    return
  }
  if (result.kind === 'error') {
    assert.equal(typeof result.text, 'string', 'error text must be a string')
    assert.ok(result.text.trim().length > 0, 'error text must not be empty')
    return
  }
  assert.fail(`command "${name}" returned unknown result kind "${String(result.kind)}"`)
}

// ── doubles ──────────────────────────────────────────────────────────

function makeCredentialsStub(opts = {}) {
  const stored = opts.stored || {}
  const sets = []
  const unsets = []
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
      const p = providerFromRef(ref)
      const rec = p ? stored[p] : null
      return rec && rec.value ? { value: rec.value, source: rec.source || 'credentials' } : null
    },
    async describe(ref) {
      const p = providerFromRef(ref)
      const rec = p ? stored[p] : null
      return rec && rec.value
        ? { configured: true, source: rec.source || 'credentials', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      sets.push({ key: ref, value })
      const p = providerFromRef(ref)
      if (p) stored[p] = { value, source: 'credentials' }
    },
    async unset(ref) {
      unsets.push({ key: ref })
      const p = providerFromRef(ref)
      if (p) delete stored[p]
    },
  }
}

function makeCtx(credentials) {
  return { get: (key) => (key === 'credentials' ? credentials : null) }
}

function makeProbeStub() {
  return {
    calls: [],
    async run(o) {
      this.calls.push(o)
      return {
        severity: 'ok',
        activeProbe: o && o.activeProbe === true ? true : undefined,
        providers: [{ id: 'exa', credentialMode: 'pool', credentialsSource: 'unprobed', credentials: '1 configured' }],
        adapters: [{ id: 'rss', activeBackend: 'native', cheap: true, enabled: true }],
        cache: { entries: 0, bytes: 0, oldestFetchedAt: 0, hardCharCap: 20000 },
      }
    },
  }
}

// ── registration contract ────────────────────────────────────────────

test('all three command definitions pass DSH registration', () => {
  const definitions = [
    createWebDoctor({ probe: makeProbeStub() }),
    createWebCache({ ctx: { get: () => null } }),
    createWebDoctorKeys({ ctx: makeCtx(makeCredentialsStub()) }),
  ]
  for (const definition of definitions) assertDshRegisterable(definition)
  assert.deepEqual(definitions.map((d) => d.name), ['webdoctor', 'webcache', 'webdoctor-keys'])
})

test('argument-taking commands advertise input hints to the DSH 0.1.7 composer', () => {
  const definitions = [
    createWebDoctor({ probe: makeProbeStub() }),
    createWebCache({ ctx: { get: () => null } }),
    createWebDoctorKeys({ ctx: makeCtx(makeCredentialsStub()) }),
  ]
  for (const definition of definitions) {
    assert.equal(typeof definition.input, 'object', `/${definition.name} must advertise its free-form input`)
    assert.equal(typeof definition.input.hint, 'string', `/${definition.name} input hint must be a string`)
    assert.ok(definition.input.hint.trim().length > 0, `/${definition.name} input hint must not be empty`)
    assert.equal(definition.input.attachments, undefined, `/${definition.name} must not admit attachments`)
  }
  assert.match(definitions[0].input.hint, /active/)
  assert.match(definitions[1].input.hint, /get <cacheRef>/)
  assert.match(definitions[2].input.hint, /set <provider> <key>/)
  assert.equal(definitions[2].recordInput, false,
    '/webdoctor-keys must advertise input without persisting its secret-bearing tail')
})

// ── /webdoctor ───────────────────────────────────────────────────────

test('/webdoctor: handler renders the doctor report as text', async () => {
  const probe = makeProbeStub()
  const cmd = createWebDoctor({ probe })
  const result = await cmd.handler({ rawInput: '' })
  assertDshResult(result, cmd.name)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Severity: ok/)
  assert.match(result.text, /- exa \[pool\]/)
  assert.equal(probe.calls[0].activeProbe, false)
})

test('/webdoctor: --active opts into real probes', async () => {
  const probe = makeProbeStub()
  const cmd = createWebDoctor({ probe })
  await cmd.handler({ rawInput: ' --active' })
  assert.equal(probe.calls[0].activeProbe, true)
})

test('/webdoctor: missing probe is an error result, not a thrown handler', async () => {
  const cmd = createWebDoctor({})
  const result = await cmd.handler({ rawInput: '' })
  assertDshResult(result, cmd.name)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not initialised/)
})

// ── /webcache ────────────────────────────────────────────────────────

test('/webcache: list / get / purge round-trip through the handler', async () => {
  // Minimal ctx: profile-scoped, no settings namespace and no session identity.
  const ctx = { get: () => null }
  const inserted = await put(ctx, {
    kind: 'search',
    sourceProvider: 'exa',
    sources: [{ url: 'https://example.com/a' }],
    ttlMs: 60_000,
  })
  const cacheRef = inserted.cacheRef
  const cmd = createWebCache({ ctx })

  const listed = await cmd.handler({ rawInput: ' list' })
  assertDshResult(listed, cmd.name)
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /^Cache: \d+ entries \/ \d+ bytes \/ hardCharCap=\d+/)
  assert.ok(listed.text.includes(cacheRef), 'list must show the cacheRef')

  const got = await cmd.handler({ rawInput: ` get ${cacheRef}` })
  assertDshResult(got, cmd.name)
  assert.equal(got.kind, 'success')
  assert.match(got.text, new RegExp(`cacheRef: ${cacheRef}`))
  assert.match(got.text, /contentLength: 0 chars/)

  const purged = await cmd.handler({ rawInput: ` purge ${cacheRef}` })
  assertDshResult(purged, cmd.name)
  assert.equal(purged.kind, 'success')
  assert.match(purged.text, new RegExp(`purged ${cacheRef}`))

  const missing = await cmd.handler({ rawInput: ` get ${cacheRef}` })
  assertDshResult(missing, cmd.name)
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /not found/)
})

test('/webcache: default subcommand is list, and a ref-less get is an error with usage', async () => {
  const cmd = createWebCache({ ctx: { get: () => null } })
  const bare = await cmd.handler({ rawInput: '' })
  assertDshResult(bare, cmd.name)
  assert.match(bare.text, /^Cache: /)

  const noRef = await cmd.handler({ rawInput: ' get' })
  assertDshResult(noRef, cmd.name)
  assert.equal(noRef.kind, 'error')
  assert.match(noRef.text, /cacheRef is required/)

  const unknown = await cmd.handler({ rawInput: ' explode' })
  assertDshResult(unknown, cmd.name)
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /unknown subcommand: explode/)
})

// ── /webdoctor-keys ──────────────────────────────────────────────────

test('/webdoctor-keys: declares recordInput=false so the key never reaches the session log', () => {
  const cmd = createWebDoctorKeys({ ctx: makeCtx(makeCredentialsStub()) })
  assert.equal(cmd.recordInput, false)
})

test('/webdoctor-keys: help / status / list / test render through the handler', async () => {
  const credentials = makeCredentialsStub({
    stored: { exa: { value: 'example-credential-aaaa1234', source: 'credentials' } },
  })
  const cmd = createWebDoctorKeys({ ctx: makeCtx(credentials) })

  const help = await cmd.handler({ rawInput: '' })
  assertDshResult(help, cmd.name)
  assert.match(help.text, /Usage: \/webdoctor-keys/)

  const status = await cmd.handler({ rawInput: ' status' })
  assertDshResult(status, cmd.name)
  assert.match(status.text, /1 with a configured key/)
  assert.match(status.text, /\/webdoctor-keys set \w+ <your-key>/)

  const listed = await cmd.handler({ rawInput: ' list' })
  assertDshResult(listed, cmd.name)
  assert.match(listed.text, /slot1=SET last-4:1234/)
  assert.equal(listed.text.includes('example-credential-aaaa1234'), false, 'list must never echo a stored value')

  const tested = await cmd.handler({ rawInput: ' test exa' })
  assertDshResult(tested, cmd.name)
  assert.match(tested.text, /exa: SET/)
  assert.match(tested.text, /last-4: 1234/)
  assert.equal(tested.text.includes('example-credential-aaaa1234'), false, 'test must never echo a stored value')
})

test('/webdoctor-keys: set writes through the seam and renders only the last-4 fingerprint', async () => {
  const credentials = makeCredentialsStub()
  const cmd = createWebDoctorKeys({ ctx: makeCtx(credentials) })

  const set = await cmd.handler({ rawInput: ' set exa example-credential-deadbeef' })
  assertDshResult(set, cmd.name)
  assert.equal(set.kind, 'success')
  assert.equal(credentials.state.sets.length, 1)
  assert.equal(credentials.state.sets[0].key, 'EXA_API_KEY')
  assert.equal(credentials.state.sets[0].value, 'example-credential-deadbeef')
  assert.match(set.text, /last-4: beef/)
  assert.equal(set.text.includes('example-credential-deadbeef'), false, 'the rendered result must not echo the key')

  const clear = await cmd.handler({ rawInput: ' clear exa' })
  assertDshResult(clear, cmd.name)
  assert.equal(clear.kind, 'success')
  assert.match(clear.text, /exa key cleared/)
  assert.equal(credentials.state.unsets.length, 1)
  assert.equal(credentials.state.unsets[0].key, 'EXA_API_KEY')
})

test('/webdoctor-keys: bad input is an error result with the actionable message', async () => {
  const cmd = createWebDoctorKeys({ ctx: makeCtx(makeCredentialsStub()) })

  for (const [rawInput, pattern] of [
    [' set exa', /key is required/],
    [' set exa changeme', /placeholder key/],
    [' set nope sk-x', /unknown provider/],
    [' clear nope', /unknown provider/],
    [' frobnicate', /unknown subcommand/],
  ]) {
    const result = await cmd.handler({ rawInput })
    assertDshResult(result, cmd.name)
    assert.equal(result.kind, 'error', `"${rawInput.trim()}" must fail`)
    assert.match(result.text, pattern)
  }
})

test('/webdoctor-keys: a missing credentials service is an error result', async () => {
  const cmd = createWebDoctorKeys({ ctx: { get: () => null } })
  const result = await cmd.handler({ rawInput: ' list' })
  assertDshResult(result, cmd.name)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /credentials service unavailable/)
})
