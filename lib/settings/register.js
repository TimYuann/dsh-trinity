// lib/settings/register.js — register + read the web-access-chain settings
// namespace (SPEC §II.3.2 Contract B).
//
// `ctx.settings.register(ns, schema, options?)` is the single registration
// point (verified by `cordis_inspect_query { service: 'settings' }`). The
// registration is an effect: disposing the fiber removes the namespace
// and its observers.
//
// The settings returned by `ctx.settings.get('web-access-chain')` are the
// authoritative source for everything below the provider/fetch seam:
// runtime budgets, cache, fetch policy, adapter/tool gates, and
// source_check. (The legacyImportVersion marker was removed in v2.1.)

import { WebAccessChainSchema, SETTINGS_NAMESPACE } from '../config-schema.js'

/**
 * @typedef {{
 *   ns: string,
 *   scope: any,
 *   settings: any,
 *   dispose: () => void,
 *   get: () => any,
 * }} SettingsHandle
 */

/**
 * Register the web-access-chain settings namespace on the calling plugin's
 * fiber. Returns a SettingsHandle whose `get()` reads the resolved value
 * (with all defaults populated by the schema's autofix), whose
 * `dispose()` unregisters the namespace.
 *
 * @param {any} ctx
 * @param {{ base?: object }} [options]
 * @returns {SettingsHandle | null}
 */
export function registerSettings(ctx, options = {}) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const settings = ctx.get('settings')
  if (!settings || typeof settings.register !== 'function') return null

  // settings.register(ns, schema, options) returns a disposer that is
  // already an effect on the calling plugin's fiber — disposing the
  // fiber removes the namespace and its observers (P0 #3).
  // The caller MUST wrap this disposer with ctx.effect(...) so that
  // cordis_stop / cordis_undefine fire it.
  const disposer = settings.register(SETTINGS_NAMESPACE, /** @type {any} */ (WebAccessChainSchema), {
    ...(options.base ? { base: options.base } : {}),
  })
  const scope = { ns: SETTINGS_NAMESPACE, schema: WebAccessChainSchema, options }

  function read() {
    try {
      const v = settings.get(SETTINGS_NAMESPACE)
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }

  function dispose() {
    try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
  }

  return {
    ns: SETTINGS_NAMESPACE,
    scope,
    settings,
    disposer,        // raw effect disposer — wrap with ctx.effect()
    dispose,         // pre-bound caller-friendly call
    get: read,
  }
}

/**
 * Read the current resolved web-access-chain settings object. Convenience
 * wrapper that handles the case where settings haven't been registered.
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
 * `webdoctor` (slash commands) for small one-key updates.
 *
 * @param {any} ctx
 * @param {string} dottedPath  e.g. 'cacheTtlMs' or 'mmxFallback'
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
