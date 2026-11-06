// test/cache/storage.test.js — the storage-form seam must never assume a
// form the host does not mount.
//
// DSH 0.2.1-rc.5 reality (verified against the installed host packages):
//   * `dsh-storage` — `storage.form(name)` THROWS
//     `StorageError('form-not-mounted')` for a form that is not mounted.
//   * `dsh-storage-domain` — mounts exactly ONE form, named `domain`.
//   * `dsh-storage-json` — provides a BACKEND, not a form.
//
// The plugin used to assume a form named `default`, which no supported host
// mounts: the call always threw, the surrounding try/catch swallowed it, and
// the storage-backed branch was dead code. These tests pin the replacement
// behaviour — resolve by capability, probe only real candidates, and never
// let the storage seam break a cache read/write.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { put, get } from '../../lib/cache/index.js'
import { savePayload, loadPayload, PAYLOAD_REF_INLINE, PAYLOAD_REF_STORAGE } from '../../lib/cache/storage.js'

/** A host storage service with NO form mounted: every `form()` call throws. */
function storageWithoutForms() {
  const probed = []
  return {
    probed,
    form(name) {
      probed.push(name)
      throw new Error(`storage form '${String(name)}' is not mounted`)
    },
  }
}

/**
 * A host storage service that mounts ONLY the `domain` form, shaped like the
 * real DomainFacility: `open` / `get(name)` / `closeAll` — no key/value
 * `put`, so it cannot hold a page payload.
 */
function storageWithDomainOnly() {
  const probed = []
  const domainFacility = {
    async open() { return undefined },
    get() { return undefined },
    async closeAll() {},
  }
  return {
    probed,
    form(name) {
      probed.push(name)
      if (name === 'domain') return domainFacility
      throw new Error(`storage form '${String(name)}' is not mounted`)
    },
  }
}

/** A host storage service whose `domain` form IS a key/value pair. */
function storageWithKvDomain() {
  const probed = []
  const store = new Map()
  const domainForm = {
    async put(key, value) { store.set(key, value); return { ok: true } },
    async get(key) { return store.has(key) ? { content: store.get(key) } : undefined },
  }
  return {
    probed,
    store,
    form(name) {
      probed.push(name)
      if (name === 'domain') return domainForm
      throw new Error(`storage form '${String(name)}' is not mounted`)
    },
  }
}

/** A ctx good enough for the cache layer: agents (host-shaped) + storage. */
function stubCtx(storage) {
  return {
    get(key) {
      if (key === 'agents') {
        // The host's Agent contract exposes `id` (a SessionId) — not
        // `sessionId` (see lib/cache/visibility.js).
        return { currentInitiator() { return { id: 'session-A' } } }
      }
      if (key === 'storage') return storage
      return null
    },
  }
}

// ── the dead assumption is gone ────────────────────────────────────────

test('storage: the plugin never probes a form named "default"', async () => {
  const storage = storageWithKvDomain()
  const ctx = stubCtx(storage)
  await savePayload(ctx, 'wac_probe', 'payload')
  assert.ok(storage.probed.length > 0, 'the storage seam must actually be probed')
  assert.equal(storage.probed.includes('default'), false,
    `no supported host mounts a "default" form; probed: ${JSON.stringify(storage.probed)}`)
})

// ── no form mounted at all ─────────────────────────────────────────────

test('storage: a storage service with NO mounted form never throws', async () => {
  const storage = storageWithoutForms()
  const ctx = stubCtx(storage)

  const saved = await savePayload(ctx, 'wac_none', 'payload without a form')
  assert.equal(saved.store, PAYLOAD_REF_INLINE)
  assert.equal(saved.ref, 'wac_none')

  const loaded = await loadPayload(ctx, 'wac_none')
  assert.equal(loaded, null, 'an unmounted form yields no payload — and no throw')
})

test('cache: read + write round-trip with NO mounted form', async () => {
  const storage = storageWithoutForms()
  const ctx = stubCtx(storage)
  const content = 'inline payload survives without any mounted form'
  const { cacheRef } = await put(ctx, {
    kind: 'page',
    sources: [{ url: 'https://example.com' }],
    inlineContent: content,
  })
  const { content: read } = await get(ctx, cacheRef)
  assert.equal(read, content, 'the cache must still round-trip its content')
})

// ── only the `domain` form is mounted (the real 0.2.1 host) ───────────

test('storage: the host-mounted "domain" form is probed, not "default"', async () => {
  const storage = storageWithDomainOnly()
  const ctx = stubCtx(storage)
  await savePayload(ctx, 'wac_domain', 'payload')
  assert.ok(storage.probed.includes('domain'), 'the mounted form must be probed')
  assert.equal(storage.probed.includes('default'), false)
})

test('storage: a domain form without a key/value pair falls back to inline', async () => {
  const storage = storageWithDomainOnly()
  const ctx = stubCtx(storage)

  const saved = await savePayload(ctx, 'wac_domain', 'payload')
  assert.equal(saved.store, PAYLOAD_REF_INLINE,
    'a form that cannot be written AND read back must not be used')

  const loaded = await loadPayload(ctx, 'wac_domain')
  assert.equal(loaded, null)
})

test('cache: read + write round-trip with only the "domain" form mounted', async () => {
  const storage = storageWithDomainOnly()
  const ctx = stubCtx(storage)
  const content = 'inline payload survives with only the domain form mounted'
  const { cacheRef } = await put(ctx, {
    kind: 'page',
    sources: [{ url: 'https://example.com' }],
    inlineContent: content,
  })
  const { content: read } = await get(ctx, cacheRef)
  assert.equal(read, content, 'the cache must still round-trip its content')
})

// ── a usable key/value form still works ───────────────────────────────

test('storage: a form with put + get keeps the storage-backed path alive', async () => {
  const storage = storageWithKvDomain()
  const ctx = stubCtx(storage)

  const saved = await savePayload(ctx, 'wac_kv', 'stored payload')
  assert.equal(saved.store, PAYLOAD_REF_STORAGE)
  assert.equal(saved.bytes, Buffer.byteLength('stored payload', 'utf8'))

  const loaded = await loadPayload(ctx, 'wac_kv')
  assert.equal(loaded, 'stored payload')
})

test('cache: read + write round-trip through a storage-backed form', async () => {
  const storage = storageWithKvDomain()
  const ctx = stubCtx(storage)
  const content = 'payload stored in the host form'
  const { cacheRef } = await put(ctx, {
    kind: 'page',
    sources: [{ url: 'https://example.com' }],
    inlineContent: content,
  })
  const { content: read } = await get(ctx, cacheRef)
  assert.equal(read, content)
})

// ── no storage service at all ─────────────────────────────────────────

test('storage: a missing storage service never throws', async () => {
  const ctx = { get: () => null }
  const saved = await savePayload(ctx, 'wac_nostorage', 'payload')
  assert.equal(saved.store, PAYLOAD_REF_INLINE)
  const loaded = await loadPayload(ctx, 'wac_nostorage')
  assert.equal(loaded, null)
})
