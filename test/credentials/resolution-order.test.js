// test/credentials/resolution-order.test.js — Credential resolution order
// regression guard (DSH 0.2.1-rc.5 conformance).
//
// Host truth, verified against the installed
// @deepseek-ai/dsh-credentials-local `resolve(ref)`:
//
//   saved store (source "file") → launch environment (source "env") → .env
//
// The store WINS. Before this fix the plugin's comments and user-visible
// copy claimed the opposite ("process env → store"), which misled users
// into believing an exported environment variable overrides an already
// saved key. The plugin's BEHAVIOUR was always correct — it only ever
// reads credentials through `ctx.credentials.resolve()` — so these tests
// lock both halves of the fix:
//
//   1. BEHAVIOUR — the plugin never consults `process.env` ahead of the
//      seam, so the host's store-first order governs the result.
//   2. COPY — the user-visible text and the source comments state the
//      store-first order and no longer contain the reversed wording.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveCredentialPool } from '../../lib/credentials/resolve.js'
import { createCommand } from '../../lib/commands/webdoctor-keys.js'

/**
 * @param {any} credentials
 */
function makeCtx(credentials) {
  return {
    get(key) {
      return key === 'credentials' ? credentials : null
    },
  }
}

test('resolveCredentialPool: the seam value is used even when an env var exists', async () => {
  // The host's store-first order is the seam's job; the plugin must not
  // short-circuit it by reading process.env first.
  process.env.EXA_API_KEY = 'env-value-must-not-be-used'
  try {
    const credentials = {
      async resolve(ref) {
        if (ref !== 'EXA_API_KEY') return undefined
        return { value: 'store-value', source: 'file' }
      },
    }
    const pool = await resolveCredentialPool('exa', makeCtx(credentials), 1)
    assert.equal(pool.EXA_API_KEY.key, 'store-value')
    assert.equal(pool.EXA_API_KEY.source, 'file')
  } finally {
    delete process.env.EXA_API_KEY
  }
})

test('resolveCredentialPool: no credentials service → no process.env fallback', async () => {
  process.env.BRAVE_API_KEY = 'env-value-must-not-be-used'
  try {
    const pool = await resolveCredentialPool('brave', makeCtx(null), 1)
    assert.equal(pool.BRAVE_API_KEY, null)
  } finally {
    delete process.env.BRAVE_API_KEY
  }
})

test('/webdoctor-keys help: states the store-first resolution order', async () => {
  const cmd = createCommand({ ctx: makeCtx(null) })
  const r = await cmd.execute({ subcommand: 'help' })
  assert.equal(r.ok, true)
  assert.match(r.message, /credential store →/)
  assert.match(r.message, /launch environment/)
  assert.equal(r.message.includes('process env → store'), false,
    'help must not repeat the reversed (env-first) order')
  assert.equal(r.message.includes('env wins'), false,
    'help must not claim the environment beats the store')
})

test('/webdoctor-keys status: onboarding hint states the store-first resolution order', async () => {
  const credentials = {
    async describe() { return { configured: false, writable: true } },
    async resolve() { return undefined },
  }
  const cmd = createCommand({ ctx: makeCtx(credentials) })
  const r = await cmd.execute({ subcommand: 'status' })
  assert.equal(r.ok, true)
  assert.match(r.hint, /credential store → launch environment/)
  assert.equal(r.hint.includes('process env → credential store'), false,
    'status hint must not repeat the reversed (env-first) order')
})

test('credential sources never document the reversed (env-first) order', async () => {
  const forbidden = [
    'env wins over',
    'process env → store',
    'process env → credential store',
    'inherited process env (wins)',
    'layers process env',
  ]
  const files = [
    '../../lib/credentials/resolve.js',
    '../../lib/commands/webdoctor-keys.js',
    // The same wording also reached the model through the tool guidance and
    // the README, so both are guarded too.
    '../../lib/tool-guidance.js',
    '../../README.md',
  ]
  for (const rel of files) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8')
    for (const phrase of forbidden) {
      assert.equal(text.includes(phrase), false,
        `${rel} must not contain the reversed wording "${phrase}"`)
    }
  }
})

test('resolve.js documents the store → launch environment → .env order', async () => {
  const text = await readFile(new URL('../../lib/credentials/resolve.js', import.meta.url), 'utf8')
  assert.match(text, /saved store[\s\S]*launch environment[\s\S]*\.env/i)
  assert.match(text, /STORE WINS/)
})
