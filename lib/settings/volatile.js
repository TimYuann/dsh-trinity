// lib/settings/volatile.js — read-through of DSH volatile config references.
//
// DSH config fields marked `.volatile()` (schemastery) do NOT resolve to
// plain values. They resolve to a frozen reference:
//
//   { get: () => value, [Symbol.for('cosmokit.volatile.write')]: (next) => … }
//
// That is the whole point of the marker: `createVolatile()` hands the plugin
// a STABLE handle, and a live settings edit writes the new value into that
// same handle — Cordis `Entry.update()` detects a volatile-only change,
// calls `updateVolatile(existingRef, nextRef)` and emits
// `loader/volatile-update` instead of restarting the plugin fiber.
//
// So a plugin that snapshots `.get()` once at apply() time goes stale on the
// first live edit, while a plugin that unwraps on every read is always
// current. This module owns that unwrap.
//
// The marker is a cross-realm Symbol (`Symbol.for`), which is why detection
// does not need a `cosmokit` import: ESM and CJS copies of the library agree
// on the key.

/** The shared volatile-reference write symbol (cosmokit). */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * @param {any} value
 * @returns {boolean} whether `value` is a cosmokit volatile config reference.
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Replace every volatile reference with its current value, recursively.
 *
 * Copy-on-write: a branch that contains no reference is returned unchanged,
 * so plain configs keep object identity and the common path allocates
 * nothing.
 *
 * @param {any} value
 * @returns {any}
 */
export function unwrapVolatile(value) {
  if (isVolatileRef(value)) {
    try {
      return unwrapVolatile(value.get())
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = unwrapVolatile(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    // Leave class instances (Errors, Maps, …) exactly as they are.
    if (proto !== Object.prototype && proto !== null) return value
    let changed = false
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      const next = unwrapVolatile(child)
      if (next !== child) changed = true
      out[key] = next
    }
    return changed ? out : value
  }
  return value
}
