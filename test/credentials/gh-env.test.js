// test/credentials/gh-env.test.js — the `gh` CLI environment.
//
// The host subprocess seam scrubs credential-shaped environment entries
// from the inherited base, so the GitHub token has to be forwarded
// EXPLICITLY (a string value in the caller's `env` is a deliberate opt-in
// that survives the scrub). This is the only implementation of that
// forwarding, so it needs its own coverage.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ghEnv } from '../../lib/credentials/gh-env.js'

test('ghEnv forwards GH_TOKEN when the environment carries one', () => {
  const env = ghEnv({ GH_TOKEN: 'ghp_example' })
  assert.deepEqual(env, { GH_TOKEN: 'ghp_example' })
})

test('ghEnv forwards GITHUB_TOKEN when that is the one set', () => {
  const env = ghEnv({ GITHUB_TOKEN: 'github_example' })
  assert.deepEqual(env, { GITHUB_TOKEN: 'github_example' })
})

test('ghEnv forwards both when both are set', () => {
  const env = ghEnv({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' })
  assert.deepEqual(env, { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' })
})

test('ghEnv returns undefined when no token is present', () => {
  assert.equal(ghEnv({}), undefined)
  assert.equal(ghEnv({ GH_TOKEN: '' }), undefined)
  assert.equal(ghEnv({ SOME_OTHER_TOKEN: 'x' }), undefined)
})

test('the gh adapters forward the token through the spawn spec', async () => {
  // The adapter and the tool both build the spec through ghEnv(); assert
  // the value actually reaches the seam, and that nothing else does.
  const { runSubprocess } = await import('../../lib/util/subprocess.js')
  const saved = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'ghp_forwarded'
  try {
    const calls = []
    const ctx = {
      get(name) {
        if (name !== 'subprocess') return undefined
        return {
          spawn(spec) {
            calls.push(spec)
            return {
              stdin: undefined,
              stdout: undefined,
              stderr: undefined,
              control: undefined,
              collected: {
                stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
              done: Promise.resolve({ exitCode: 0, signal: null }),
              terminate() {},
              waitForExit: async () => true,
            }
          },
        }
      },
    }
    await runSubprocess(ctx, { argv: ['gh', 'api', 'x'], timeoutMs: 1000, env: ghEnv() })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].env.GH_TOKEN, 'ghp_forwarded')
    assert.equal(Object.keys(calls[0].env).length, 1, 'only the token is forwarded')
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
  }
})
