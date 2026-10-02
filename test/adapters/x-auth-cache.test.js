// test/adapters/x-auth-cache.test.js — login-gated evidence must not
// become profile-wide readable.
//
// The chain under test is:
//   adapter fetch (authenticated: true)
//     → normalizeAdapterResult must PRESERVE the flag
//       → source_check must pass it to the evidence cache
//         → a DIFFERENT session on the same profile must be refused
//
// Each of those three links failed or did not exist before this change:
// normalizeAdapterResult dropped the field entirely, and source_check
// hardcoded `authenticated: false`. Testing only one link would let the
// other two regress unnoticed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTool as createSourceCheck } from '../../lib/tools/source-check.js'
import { get } from '../../lib/cache/index.js'

const sharedFormStore = new Map()
const sharedFormStub = {
  async put(key, value) { sharedFormStore.set(key, value); return { ok: true } },
  async get(key) { return sharedFormStore.has(key) ? { content: sharedFormStore.get(key) } : undefined },
}

function makeStubCtx({ profileId = 'default-profile', sessionId = 'session-A' } = {}) {
  return {
    session: { id: sessionId },
    get(key) {
      if (key === 'agents') {
        return { currentInitiator() { return { sessionId, id: sessionId } } }
      }
      if (key === 'settings') {
        return {
          get(ns) {
            if (ns === 'dsh.profile') return { id: profileId }
            if (ns === 'web-access-chain.profile') return { id: profileId }
            return null
          },
        }
      }
      if (key === 'storage') {
        return {
          form(name) {
            if (name === 'default' || name === 'webAccessCache' || name === undefined) return sharedFormStub
            return null
          },
        }
      }
      return null
    },
  }
}

const MARKER = 'UNIQUE-LOGIN-GATED-TIMELINE-TEXT-9f3a'

function runSourceCheckWith({ authenticated }) {
  const ctx = makeStubCtx({ sessionId: 'session-A' })
  const tool = createSourceCheck({
    ctx,
    settings: {},
    chainedCtx: {},
    searchImpl: async () => ({ sources: [{ url: 'https://x.com/karpathy', title: 'karpathy' }] }),
    fetchImpl: async () => ({
      url: 'https://x.com/karpathy',
      statusCode: 200,
      body: { kind: 'html', content: `timeline body ${MARKER} ${'padding '.repeat(20)}`, extraction: 'x' },
      contentType: 'text/markdown',
      contentDigest: 'digest-a',
      adapterId: authenticated ? 'x' : 'generic-html',
      truncated: false,
      authenticated,
    }),
  })
  return tool.execute({ claim: 'karpathy posted about evals', subQueries: ['karpathy evals', 'karpathy timeline'], maxPages: 1 }, {})
}

test('x: login-gated evidence is cached session-scoped, not profile-wide', async () => {
  const result = await runSourceCheckWith({ authenticated: true })
  const refs = result.evidenceSnapshotRefs || []
  assert.equal(refs.length, 1, 'the stubbed fetch should have produced one snapshot')
  const cacheRef = refs[0].cacheRef
  assert.ok(cacheRef)

  // The WRITING session may read it back.
  const own = await get(makeStubCtx({ sessionId: 'session-A' }), cacheRef)
  assert.ok(own, 'the writing session must be able to read its own evidence')

  // A DIFFERENT session on the SAME profile must not.
  await assert.rejects(
    () => get(makeStubCtx({ sessionId: 'session-B' }), cacheRef),
    (e) => {
      assert.equal(e.code, 'WEB_CONTENT_FORBIDDEN')
      return true
    },
    'an authenticated cache entry must be session-scoped',
  )
})

test('x: public evidence stays readable across sessions on the same profile', async () => {
  // The control: the same path with authenticated: false must NOT become
  // session-scoped, or we would have "fixed" isolation by breaking the
  // public cache.
  const result = await runSourceCheckWith({ authenticated: false })
  const refs = result.evidenceSnapshotRefs || []
  if (refs.length === 0) return // heuristic scoring may drop the only page; nothing to assert
  const cacheRef = refs[0].cacheRef
  const other = await get(makeStubCtx({ sessionId: 'session-B' }), cacheRef)
  assert.ok(other, 'public evidence must remain readable by the same profile')
})
