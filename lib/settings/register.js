// lib/settings/register.js — register + expose the live web-access-chain
// settings scope (SPEC §II.3.2 Contract B).
//
// `ctx.settings.register(ns, schema, options)` returns a real
// `SettingsScope` with `get()`, `watch()`, `update()`, `replace()`. The
// returned scope is already bound to the calling Cordis fiber — disposing
// the fiber removes the namespace and its watchers. Do NOT fabricate a
// `disposer` here; the planner (lib/index.js) only retains the scope's
// watcher disposer if it wants explicit lifecycle control.
//
// C1 (corrections): the previous implementation captured
// `settings.register(...)` into a local `disposer` and never used the
// returned scope. This module is now a thin wrapper that exposes the
// real scope and its `watch` API to `apply()`.

import { WebAccessChainSchema, SETTINGS_NAMESPACE } from '../config-schema.js'

/**
 * Register the web-access-chain settings namespace on the calling plugin's
 * fiber. Returns a handle whose `get()` reads the current resolved value
 * (with all defaults populated by the schema's autofix) and whose `watch()`
 * subscribes to live updates. The returned scope's `replace()` /
 * `update()` methods are reachable through the host-issued scope object.
 *
 * @param {any} ctx
 * @param {{ base?: object }} [options]
 * @returns {{ scope: any, get: () => any, watch: (handler: (next: any) => void) => () => void } | null}
 */
export function registerSettings(ctx, options = {}) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const settings = ctx.get('settings')
  if (!settings || typeof settings.register !== 'function') return null

  const scope = settings.register(SETTINGS_NAMESPACE, /** @type {any} */ (WebAccessChainSchema), {
    ...(options.base ? { base: options.base } : {}),
  })

  // Fallback path: if the host-issued scope is stubbed (unit tests, missing
  // autofix) and `scope.get()` returns an empty object, fall back to
  // `settings.get(ns)` so unit-test seams still observe real settings.
  const settingsGet = (ns) => {
    try {
      const v = settings.get(ns)
      return v && typeof v === 'object' ? v : {}
    } catch { return {} }
  }

  const effectiveGet = () => {
    if (!scope || typeof scope.get !== 'function') return settingsGet(SETTINGS_NAMESPACE)
    try {
      const v = scope.get()
      if (v && typeof v === 'object' && Object.keys(v).length > 0) return v
    } catch { /* fall through */ }
    return settingsGet(SETTINGS_NAMESPACE)
  }

  return {
    scope,
    get: effectiveGet,
    watch: (handler) => (typeof scope.watch === 'function' ? scope.watch(handler) : () => {}),
  }
}

/**
 * Read the current resolved web-access-chain settings object.
 *
 * @param {any} ctx
 * @returns {any}
 */
export function readSettings(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const settings = ctx.get('settings')
  if (!settings || typeof settings.get !== 'function') return null
  try {
    return settings.get(SETTINGS_NAMESPACE)
  } catch {
    return null
  }
}

/**
 * Patch a single sub-key of web-access-chain. Used by `webcache` and
 * `webdoctor` slash commands for small one-key updates.
 *
 * @param {any} ctx
 * @param {string} dottedPath
 * @param {any} value
 */
export async function patchSetting(ctx, dottedPath, value) {
  if (!ctx || typeof ctx.get !== 'function') return
  const settings = ctx.get('settings')
  if (!settings || typeof settings.update !== 'function') return
  try {
    await settings.update(SETTINGS_NAMESPACE, { [dottedPath]: value })
  } catch {
    // Best-effort.
  }
}

/**
 * Create a tiny mutable reference owned by `apply()`. Every consumer
 * reads `runtime.get()` which always returns the latest settings value
 * known to the live `SettingsScope`. This is the single live settings
 * source inside the plugin; every gate, budget, and policy consumer
 * must point here, not at the value captured at apply() time.
 *
 * @param {{ get: () => any } | null | undefined} handle
 * @param {any} fallback
 */
export function createRuntimeSettings(handle, fallback) {
  let current
  if (handle && typeof handle.get === 'function') {
    try {
      const v = handle.get()
      if (v && typeof v === 'object' && Object.keys(v).length > 0) current = v
      else current = fallback
    } catch {
      current = fallback
    }
  } else {
    current = fallback
  }
  return {
    get: () => current,
    /** @param {any} next */
    replace: (next) => { current = next },
  }
}
