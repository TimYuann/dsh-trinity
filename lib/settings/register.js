// lib/settings/register.js — live web-access-chain settings resolution.
//
// TWO HOST ERAS, ONE CONTRACT
//
//   DSH <= 0.1.6-alpha.1 shipped a `SettingsProvider` on ctx.settings with
//   `register(ns, schema, { base })` returning a live SettingsScope
//   (`get()` / `watch()` / `update()`).
//
//   DSH >= 0.1.7-alpha.1 (through 0.2.0-rc.2) replaced it with
//   `SettingsForms` — the service only exposes `configure` / `describe` /
//   `update` / `replace` / `mutate`, and it is keyed by PROFILE ENTRY ID.
//   There is no `register`, no `get`, and no `watch`.
//
// The previous implementation called `settings.register(...)` and silently
// fell back to `{}` when it was missing, which is why every deployment since
// 0.1.7-alpha.1 ran with an empty settings object: `cordis.patch.yml`
// values (routing, budgets, cache, adapter gates, SSRF policy, …) were
// parsed and passed to `apply(ctx, config)` — and then dropped on the floor.
//
// The modern contract is different, not missing: the plugin entry exports a
// schemastery `Config`, the Loader resolves schema defaults over the row's
// raw config and hands the result to `apply(ctx, config)`, and a profile
// patch edit restarts this fiber (Cordis `Fiber.update()` → dispose +
// re-apply). So the resolved `config` argument IS the live value for this
// fiber's lifetime; long-lived watchers are unnecessary.
//
// `registerSettings` therefore returns a base-backed handle when the legacy
// service is absent, and `readSettings` / `patchSetting` speak the modern
// form API (entry-id keyed describe/mutate) when present.

import { WebAccessChainSchema, SETTINGS_NAMESPACE } from '../config-schema.js'
import { unwrapVolatile } from './volatile.js'

/**
 * The profile entry id that owns this plugin's configuration. The Loader
 * entry is authoritative (a profile may mount the bundle under any id);
 * `web-access-chain` is the id this bundle's own patch declares and the
 * fallback for contexts without a Loader entry (unit tests, headless).
 *
 * @param {any} ctx
 * @returns {string}
 */
export function settingsEntryId(ctx) {
  try {
    const id = ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.id
    if (typeof id === 'string' && id.length > 0) return id
  } catch {
    // A disposed fiber throws on property access; fall through to the default.
  }
  return SETTINGS_NAMESPACE
}

/**
 * Register / adopt the web-access-chain configuration.
 *
 * Legacy hosts (ctx.settings.register exists): register the namespace and
 * return the host-issued scope, exactly as before.
 *
 * Modern hosts: return a handle backed by the `base` config the Loader
 * already resolved through the exported `Config` schema. `watch()` is a
 * no-op disposer — a profile patch edit restarts the plugin fiber, so
 * every consumer re-reads a fresh handle after re-apply.
 *
 * @param {any} ctx
 * @param {{ base?: object }} [options]
 * @returns {{ scope: any, source: 'scope' | 'config', get: () => any, watch: (handler: (next: any) => void) => () => void } | null}
 */
export function registerSettings(ctx, options = {}) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const base = (options.base && typeof options.base === 'object' && !Array.isArray(options.base))
    ? options.base
    : {}
  const settings = ctx.get('settings')

  // ── Modern era (DSH >= 0.1.7): no register/get/watch; `base` is the
  //    resolved Config the Loader validated and passed to apply(). Its
  //    volatile fields are live references, so every read unwraps freshly:
  //    a settings edit writes the new value into the same reference and the
  //    fiber is NOT restarted.
  if (!settings || typeof settings.register !== 'function') {
    return {
      scope: null,
      source: 'config',
      get: () => unwrapVolatile(base),
      watch: () => () => {},
    }
  }

  // ── Legacy era (DSH <= 0.1.6): real SettingsScope with live updates.
  const scope = settings.register(SETTINGS_NAMESPACE, /** @type {any} */ (WebAccessChainSchema), {
    ...(Object.keys(base).length > 0 ? { base } : {}),
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
    source: 'scope',
    get: effectiveGet,
    watch: (handler) => (typeof scope.watch === 'function' ? scope.watch(handler) : () => {}),
  }
}

/**
 * Read the current resolved web-access-chain settings object.
 *
 * Legacy hosts: `settings.get(ns)`.
 * Modern hosts: the volatile form descriptor for this entry (keyed by the
 * Loader entry id) from `settings.describe()`.
 *
 * Returns null when neither is available; callers fall back to the resolved
 * `config` argument, which is authoritative on modern hosts.
 *
 * @param {any} ctx
 * @returns {any}
 */
export function readSettings(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const settings = ctx.get('settings')
  if (!settings) return null

  if (typeof settings.get === 'function') {
    try {
      const v = settings.get(SETTINGS_NAMESPACE)
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }

  if (typeof settings.describe === 'function') {
    try {
      const rows = settings.describe({ redactSecrets: true })
      if (!Array.isArray(rows)) return null
      const id = settingsEntryId(ctx)
      const row = rows.find((r) => r && r.ns === id) || rows.find((r) => r && r.ns === SETTINGS_NAMESPACE)
      const v = row && row.value
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }

  return null
}

/**
 * Patch one sub-key of web-access-chain. Used by `webcache` / `webdoctor`
 * for small one-key updates.
 *
 * Legacy hosts: `settings.update(ns, { 'a.b': value })`.
 * Modern hosts: `settings.mutate(ns, [{ op: 'set', path: ['a','b'], value }])`,
 * which the settings service validates against the volatile form before it
 * writes the profile patch and restarts this entry.
 *
 * @param {any} ctx
 * @param {string} dottedPath
 * @param {any} value
 */
export async function patchSetting(ctx, dottedPath, value) {
  if (!ctx || typeof ctx.get !== 'function') return
  const settings = ctx.get('settings')
  if (!settings) return
  const path = String(dottedPath || '').split('.').map((s) => s.trim()).filter((s) => s.length > 0)
  if (path.length === 0) return
  const ns = settingsEntryId(ctx)

  try {
    if (typeof settings.mutate === 'function') {
      await settings.mutate(ns, [{ op: 'set', path, value }])
      return
    }
    if (typeof settings.update === 'function') {
      await settings.update(ns, nestPath(path, value))
    }
  } catch {
    // Best-effort: an unwritable or non-volatile path must not break a command.
  }
}

/**
 * Build a nested object from a dotted path so `settings.update()` merges the
 * leaf without clobbering its siblings.
 *
 * @param {string[]} path
 * @param {any} value
 * @returns {object}
 */
function nestPath(path, value) {
  const root = {}
  let node = root
  for (let i = 0; i < path.length - 1; i++) {
    node[path[i]] = {}
    node = node[path[i]]
  }
  node[path[path.length - 1]] = value
  return root
}

/**
 * Create the live settings reference owned by `apply()`.
 *
 * `get()` is deliberately read-through, not a snapshot:
 *
 *   * modern hosts hand `apply()` a Config whose volatile fields are live
 *     references — the Loader updates them in place on a settings edit and
 *     emits `loader/volatile-update` WITHOUT restarting the fiber, so a
 *     cached snapshot would silently go stale;
 *   * legacy hosts push whole-object updates through `replace()`, which
 *     still wins once called.
 *
 * Consumers therefore always read `runtime.get()` — never a value captured
 * deeper down.
 *
 * @param {{ get: () => any } | null | undefined} handle
 * @param {any} fallback
 */
export function createRuntimeSettings(handle, fallback) {
  const source = (handle && typeof handle.get === 'function') ? handle : null
  let override
  const read = () => {
    if (override !== undefined) return override
    if (source) {
      try {
        const v = source.get()
        if (v && typeof v === 'object' && Object.keys(v).length > 0) return v
      } catch { /* fall through to the fallback */ }
    }
    return fallback
  }
  return {
    get: read,
    /** @param {any} next */
    replace: (next) => { override = next },
  }
}
