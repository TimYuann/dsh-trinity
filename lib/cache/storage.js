// lib/cache/storage.js — façade over ctx.storage (SPEC §II.3.4 Contract D
// Step 1).
//
// We use ctx.storage's default form for payloads ≤ 1 MiB. When no storage
// seam (or no usable `default` form) is available, the payload is kept
// INLINE in the cache entry itself (PAYLOAD_REF_INLINE) so
// search_content can still read it back — the entry Map is process-local
// anyway, so an inline copy is no weaker than the storage-backed path
// within one process.
//
// v2.2.1: the previous spillStore branch is REMOVED. DSH's SpillStore
// service (`@deepseek-ai/dsh-spill`) deliberately exposes `saveText` and
// NO retrieval API — a spill write can never be read back by
// loadPayload, so spill refs made search_content return empty content
// even though the cacheRef existed (observed in live headless E2E). The
// storage/inline pair is the only round-trippable path.

import { makeCacheRef } from './cacheRef.js'

export const PAYLOAD_REF_STORAGE = 'storage'
export const PAYLOAD_REF_INLINE = 'inline'

/**
 * @param {any} ctx
 * @param {string} cacheRef
 * @param {string} content
 * @param {{ owner?: any, kind?: string }} [opts]
 * @returns {Promise<{ store: 'storage' | 'inline', ref: string, bytes: number }>}
 */
export async function savePayload(ctx, cacheRef, content, opts = {}) {
  const bytes = Buffer.byteLength(content || '', 'utf8')
  // Default: store via ctx.storage's default form with a content-addressable key.
  const storage = ctx && typeof ctx.get === 'function' ? ctx.get('storage') : null
  if (storage) {
    const form = pickStorageForm(storage)
    if (form && typeof form.put === 'function') {
      try {
        await form.put(cacheRef, content)
        return { store: PAYLOAD_REF_STORAGE, ref: cacheRef, bytes }
      } catch {
        // fall through to inline
      }
    }
  }
  // v2.2.1: inline marker — the cache entry itself keeps the content
  // (cache/index.js put() stores it as entry.inlineContent, get() reads it
  // back). Previously this returned a fake `inline:` ref that was never
  // written anywhere, so search_content got empty content.
  return { store: PAYLOAD_REF_INLINE, ref: cacheRef, bytes }
}

/**
 * @param {any} storage
 * @returns {any}
 */
function pickStorageForm(storage) {
  // P2 #21: ADR §2.4 says we do not assume a pre-mounted `webAccessCache`
  // form. Use `ctx.storage`'s default form directly — that is the one
  // DSH mounts unconditionally and exposes the put / get surface we
  // need. The previous try/catch probing of an undeclared form added
  // noise without a real consumer.
  if (!storage || typeof storage.form !== 'function') return null
  try {
    // `default` is the form key DSH ships by default. If a deployment
    // has mounted a different default form under another name, the
    // operator can wire that through settings.web-access-chain.storageForm.
    const def = storage.form('default')
    return def && typeof def === 'object' ? def : null
  } catch {
    return null
  }
}

function safeForm(storage, name) {
  try {
    const f = storage.form(name)
    return f && typeof f === 'object' ? f : null
  } catch {
    return null
  }
}

/**
 * @param {any} ctx
 * @param {string} cacheRef
 * @returns {Promise<string | null>}
 */
export async function loadPayload(ctx, cacheRef) {
  const storage = ctx && typeof ctx.get === 'function' ? ctx.get('storage') : null
  if (!storage || typeof storage.form !== 'function') return null
  const form = pickStorageForm(storage)
  if (!form || typeof form.get !== 'function') return null
  try {
    const v = await form.get(cacheRef)
    if (typeof v === 'string') return v
    if (v && typeof v.content === 'string') return v.content
  } catch {
    // fall through
  }
  return null
}

/**
 * Generate a fresh cacheRef + persist content. Convenience wrapper.
 *
 * @param {any} ctx
 * @param {string} content
 * @param {{ owner?: any, kind?: string }} [opts]
 * @returns {Promise<{ cacheRef: string, contentRef: any, bytes: number }>}
 */
export async function saveNewPayload(ctx, content, opts = {}) {
  const cacheRef = makeCacheRef()
  const contentRef = await savePayload(ctx, cacheRef, content, opts)
  return { cacheRef, contentRef, bytes: contentRef.bytes }
}
