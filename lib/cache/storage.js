// lib/cache/storage.js — façade over ctx.storage (SPEC §II.3.4 Contract D
// Step 1).
//
// WHERE THE CACHE CONTENT ACTUALLY LIVES (DSH 0.2.1-rc.5)
//
// The host's storage service (`@deepseek-ai/dsh-storage`) exposes FORMS, and
// `storage.form(name)` THROWS `StorageError('form-not-mounted')` when the
// named form is not mounted. What 0.2.1 actually mounts:
//
//   * `domain` — the only form mounted out of the box, by
//     `@deepseek-ai/dsh-storage-domain` (`storage.mount('domain', …)`).
//     Its surface is a DomainFacility (`open` / `get(name)` / `closeAll`) —
//     NOT a key/value pair, so it cannot hold a page payload.
//   * `@deepseek-ai/dsh-storage-json` provides a BACKEND, not a form.
//
// No supported host mounts a form named `default`. The previous
// `storage.form('default')` call therefore always threw and was swallowed
// by the surrounding try/catch: the storage-backed branch was dead code on
// every supported host, and every cached payload ended up INLINE in the
// process-local entry Map (lib/cache/index.js → `entry.inlineContent`).
//
// The form is now resolved by CAPABILITY, not by name assumption:
//
//   1. a form name from the plugin's configuration — NONE exists today:
//      lib/config-schema.js declares no storage-form key, so there is
//      nothing to honour (a key was deliberately NOT invented here);
//   2. `domain` — the form the host actually mounts;
//   3. the plugin's own inline payload (PAYLOAD_REF_INLINE) — where the
//      content ends up on every current host.
//
// Every `storage.form(...)` call is guarded: the host throws for a form
// that is not mounted.
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
 * Storage form names this plugin may use, in priority order.
 *
 * `domain` is the only form a DSH 0.2.1 host mounts by default
 * (`@deepseek-ai/dsh-storage-domain` mounts it as "domain").
 *
 * There is deliberately NO `default` entry: no supported host mounts a form
 * under that name, and asking for one throws
 * `StorageError('form-not-mounted')`. The historical `default` assumption
 * made the storage-backed branch dead code on every supported host.
 *
 * There is also NO configured form name: the plugin's config schema
 * (lib/config-schema.js) declares no storage-form key, so nothing is
 * configurable today. If such a key is added to the schema, its value goes
 * in front of the built-in candidates so an operator's choice wins.
 */
const STORAGE_FORM_NAMES = ['domain']

/**
 * @param {any} ctx
 * @param {string} cacheRef
 * @param {string} content
 * @param {{ owner?: any, kind?: string }} [opts]
 * @returns {Promise<{ store: 'storage' | 'inline', ref: string, bytes: number }>}
 */
export async function savePayload(ctx, cacheRef, content, opts = {}) {
  const bytes = Buffer.byteLength(content || '', 'utf8')
  // Prefer a host-mounted storage form; fall back to the inline payload.
  const storage = ctx && typeof ctx.get === 'function' ? ctx.get('storage') : null
  const form = pickStorageForm(storage)
  if (form) {
    try {
      await form.put(cacheRef, content)
      return { store: PAYLOAD_REF_STORAGE, ref: cacheRef, bytes }
    } catch {
      // fall through to inline
    }
  }
  // v2.2.1: inline marker — the cache entry itself keeps the content
  // (cache/index.js put() stores it as entry.inlineContent, get() reads it
  // back). Previously this returned a fake `inline:` ref that was never
  // written anywhere, so search_content got empty content.
  return { store: PAYLOAD_REF_INLINE, ref: cacheRef, bytes }
}

/**
 * Resolve the storage form this plugin should write payloads into.
 *
 * Selection is by CAPABILITY, not by name: a form is usable only when it
 * exposes BOTH `put` and `get`, so a form that can be written but not read
 * back can never strand a payload. The host's `domain` form (a
 * DomainFacility) exposes no such pair, so on DSH 0.2.1 this returns null
 * and the payload stays inline.
 *
 * @param {any} storage
 * @returns {any}
 */
function pickStorageForm(storage) {
  if (!storage || typeof storage.form !== 'function') return null
  for (const name of STORAGE_FORM_NAMES) {
    const form = safeForm(storage, name)
    if (form && typeof form.put === 'function' && typeof form.get === 'function') return form
  }
  return null
}

/**
 * Resolve one mounted form. The host THROWS for a form that is not mounted,
 * so every probe is guarded.
 *
 * @param {any} storage
 * @param {string} name
 * @returns {any}
 */
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
  if (!form) return null
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
