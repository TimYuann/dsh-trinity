// test/cache.test.js — Cache contract (SPEC §II.3.4 Contract D,
// acceptance #7 auth, #8 unauth, #15 no leakage, plus hard cap).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { put, get, readEntryContent, list, stats, purge } from '../lib/cache/index.js'
import { HARD_CHAR_CAP, readContent } from '../lib/cache/content-find.js'
import { makeCacheRef, decodeCacheRefTime } from '../lib/cache/cacheRef.js'

// Module-level shared in-memory storage. The cache layer writes to
// ctx.storage.form('default') — this Map stands in for that backend so
// put() / get() actually round-trip across separate stubs. Without a
// shared store, each makeStubCtx() would have its own Map and cross-ctx
// reads would return null.
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
        return {
          currentInitiator() {
            return { sessionId, id: sessionId }
          },
        }
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

test('cacheRef: prefix wac_, decodable', () => {
  const ref = makeCacheRef()
  assert.ok(ref.startsWith('wac_'))
  assert.equal(ref.length, 4 + 26)
  assert.ok(decodeCacheRefTime(ref) > 0)
})

test('cacheRef: two refs in the same ms differ', () => {
  const a = makeCacheRef(1700000000000)
  const b = makeCacheRef(1700000000000)
  assert.notEqual(a, b)
})

test('hardCharCap = 20 000 chars', () => {
  assert.equal(HARD_CHAR_CAP, 20_000)
})

test('readContent: offset/limit slices content', () => {
  const r = readContent('abcdefghij', { offset: 2, limit: 4 })
  assert.equal(r.content, 'cdef')
  assert.equal(r.totalChars, 10)
})

test('readContent: HARD cap at 20 000 even when limit exceeds', () => {
  const big = 'x'.repeat(50_000)
  const r = readContent(big, { offset: 0, limit: 30_000 })
  assert.ok(r.content.length <= 20_000)
})

test('readContent: findText cannot be combined with offset/limit', () => {
  assert.throws(() => readContent('hello world', { findText: 'world', offset: 0 }))
  assert.throws(() => readContent('hello world', { findText: 'world', limit: 100 }))
})

test('readContent: findText exact returns matches + surrounding context', () => {
  const text = 'lorem ipsum dolor sit amet, consectetur adipiscing elit'
  const r = readContent(text, { findText: 'dolor' })
  assert.ok(r.content.includes('dolor'))
  assert.ok(Array.isArray(r.matches) && r.matches.length === 1)
  assert.equal(r.matches[0].offset, 12)
})

test('readContent: findText case-insensitive', () => {
  const text = 'Hello World Hello World'
  const r = readContent(text, { findText: 'hello', findMode: 'case-insensitive' })
  assert.equal(r.matches.length, 2)
})

test('put + get: unauthenticated cache entry visible to same-profile session B', () => {
  // SPEC §II.3.4 / acceptance #8
  const ctxA = makeStubCtx({ profileId: 'p1', sessionId: 'session-A' })
  return put(ctxA, {
    kind: 'search',
    authenticated: false,
    sources: [{ url: 'https://example.com' }],
    inlineContent: 'hello world',
  }).then(({ cacheRef }) => {
    // session B same profile
    const ctxB = makeStubCtx({ profileId: 'p1', sessionId: 'session-B' })
    return get(ctxB, cacheRef).then(({ content }) => {
      assert.equal(content, 'hello world')
    })
  })
})

test('put + get: authenticated entry: session B in same profile CANNOT read', () => {
  // SPEC §II.3.4 / acceptance #7
  const ctxA = makeStubCtx({ profileId: 'p1', sessionId: 'session-A' })
  return put(ctxA, {
    kind: 'search',
    authenticated: true,
    sources: [{ url: 'https://secret.example' }],
    inlineContent: 'private',
  }).then(({ cacheRef }) => {
    const ctxB = makeStubCtx({ profileId: 'p1', sessionId: 'session-B' })
    return get(ctxB, cacheRef).then(
      () => { assert.fail('expected WEB_CONTENT_FORBIDDEN') },
      (err) => {
        assert.equal(err.code, 'WEB_CONTENT_FORBIDDEN')
      },
    )
  })
})

test('put + get: authenticated entry: same session CAN read', () => {
  const ctxA = makeStubCtx({ profileId: 'p1', sessionId: 'session-A' })
  return put(ctxA, {
    kind: 'search',
    authenticated: true,
    sources: [{ url: 'https://secret.example' }],
    inlineContent: 'private',
  }).then(({ cacheRef }) => {
    return get(ctxA, cacheRef).then(({ content }) => {
      assert.equal(content, 'private')
    })
  })
})

test('put + get: unauthenticated entry: different profile CANNOT read', () => {
  const ctxA = makeStubCtx({ profileId: 'p1', sessionId: 'session-A' })
  return put(ctxA, {
    kind: 'search',
    authenticated: false,
    sources: [{ url: 'https://example.com' }],
    inlineContent: 'shared',
  }).then(({ cacheRef }) => {
    const ctxC = makeStubCtx({ profileId: 'p2', sessionId: 'session-C' })
    return get(ctxC, cacheRef).then(
      () => { assert.fail('expected WEB_CONTENT_FORBIDDEN') },
      (err) => {
        assert.equal(err.code, 'WEB_CONTENT_FORBIDDEN')
      },
    )
  })
})

test('purge removes entry', async () => {
  const ctx = makeStubCtx()
  const { cacheRef } = await put(ctx, {
    kind: 'search',
    sources: [{ url: 'https://example.com' }],
    inlineContent: 'data',
  })
  assert.equal(purge(cacheRef), true)
})

test('list returns visible entries only', async () => {
  // Use a unique profile so we don't collide with other tests' cache state.
  const profileId = 'list-test-' + Date.now()
  const ctxA = makeStubCtx({ profileId, sessionId: 'session-A' })
  await put(ctxA, { kind: 'search', authenticated: true, sources: [], inlineContent: 'a' })
  await put(ctxA, { kind: 'search', authenticated: false, sources: [], inlineContent: 'b' })
  const ctxB = makeStubCtx({ profileId, sessionId: 'session-B' })
  const entries = list(ctxB).filter((e) => e.cacheRef && e.fetchedAt > Date.now() - 5000)
  // B can see only the unauthenticated one for this profile (1 entry).
  assert.equal(entries.length, 1)
  assert.equal(entries[0].authenticated, false)
})

test('stats returns counts', async () => {
  const ctx = makeStubCtx()
  const before = stats(ctx).entries
  await put(ctx, { kind: 'search', sources: [], inlineContent: 'hello' })
  const s = stats(ctx)
  assert.equal(s.entries, before + 1)
  assert.ok(s.bytes > 0)
  assert.equal(s.hardCharCap, 20_000)
})

test('readEntryContent: hard cap truncates at 20 000 instead of throwing (v2.2.1)', async () => {
  // v2.2.1: the cap is enforced by readContent (truncation), not by a
  // pre-slice throw in cache.get — the old throw made every entry
  // > 20 000 chars unreadable (source_check writes such entries), so
  // search_content could never read back a real cacheRef.
  const ctx = makeStubCtx()
  const big = 'x'.repeat(50_000)
  const { cacheRef } = await put(ctx, {
    kind: 'search',
    sources: [],
    inlineContent: big,
  })
  const r = await readEntryContent(ctx, cacheRef, { offset: 0 })
  assert.ok(r.content.length <= HARD_CHAR_CAP, 'hard cap must hold')
  assert.equal(r.totalChars, 50_000)
  // offset/limit still works beyond the cap boundary.
  const sliced = await readEntryContent(ctx, cacheRef, { offset: 30_000, limit: 10 })
  assert.equal(sliced.content, 'x'.repeat(10))
})

test('readContent inside cache.get respects the 20 000 hard cap', () => {
  // P0 #6: hard-capped at readContent (used by readEntryContent).
  const big = 'x'.repeat(50_000)
  const r = readContent(big, { offset: 0 })
  assert.ok(r.content.length <= 20_000, 'hard cap must hold')
})

test('cache entry expires after ttlMs', async () => {
  const ctx = makeStubCtx()
  const { cacheRef } = await put(ctx, {
    kind: 'search',
    sources: [],
    inlineContent: 'short',
    ttlMs: 1, // immediate expiry
  })
  // Wait briefly so Date.now() - fetchedAt > 1
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(
    get(ctx, cacheRef),
    (err) => err.code === 'WEB_CONTENT_EXPIRED',
  )
})

test('v2.2.1: no storage seam → inline fallback still round-trips content', async () => {
  // Regression lock for live-headless E2E: search_content returned
  // "(0 chars total)" for a real source_check cacheRef because the inline
  // fallback never persisted the content anywhere readable. The entry must
  // carry the content itself when ctx.storage is unavailable.
  const ctxNoStorage = {
    get(key) {
      if (key === 'agents') {
        return { currentInitiator() { return { sessionId: 'session-A', id: 'session-A' } } }
      }
      if (key === 'settings') {
        return { get() { return null } }
      }
      return null // no storage seam, no spillStore
    },
  }
  const { cacheRef } = await put(ctxNoStorage, {
    kind: 'page',
    sources: [{ url: 'https://example.com' }],
    inlineContent: 'inline payload survives without storage',
  })
  const { content } = await get(ctxNoStorage, cacheRef)
  assert.equal(content, 'inline payload survives without storage')
  const r = await readEntryContent(ctxNoStorage, cacheRef, { offset: 0, limit: 20 })
  assert.equal(r.content, 'inline payload survi')
})
