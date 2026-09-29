// lib/util/gated-register.js — settings-driven Tool registration with
// bidirectional reconcile (v2.3.0 § Commit 2).
//
// Each gated Tool reads one `settings.<path>.enabled` flag (or
// `settings.adapters.<name>.enabled` for adapter-style gates). The
// previous implementation only registered when an event fired; it
// never disposed, and there was no idempotency check on the
// `true → true` transition. Operators had to restart the plugin to
// re-enable a previously-on tool, and `true → false` leaked the
// registration.
//
// This helper consults `runtime.get()` — the plugin's live settings ref —
// and reconciles:
//
//   | Previous | Next | Action                          |
//   |----------|------|---------------------------------|
//   | false    | false | none                            |
//   | false    | true  | register once                   |
//   | true     | true  | none (idempotent)               |
//   | true     | false | dispose once                    |
//
// It also disposes any active registration on plugin teardown.
//
// v2.4.1: on DSH >= 0.1.7 there is no settings watcher at all — the Loader
// restarts this plugin's fiber when the profile patch changes, so `apply()`
// re-runs, `runtime` is rebuilt from the new resolved Config, and the
// initial reconcile below is what flips a gate. `watchRuntime()` therefore
// only ever binds on legacy hosts (<= 0.1.6) that still ship a live scope.

import { SETTINGS_NAMESPACE } from '../config-schema.js'

/**
 * Register a Tool that follows the live `settings.<path>.enabled` flag.
 *
 * @param {{
 *   ctx: any,
 *   runtime: { get: () => any },
 *   settingsKey: (settings: any) => boolean,
 *   create: () => any,
 *   register: (t: any) => any,
 *   unregister?: () => void,
 *   tools: any,
 *   label: string,
 *   safeRegister: (fn: () => any) => any,
 * }} spec
 */
export function registerIfEnabled(spec) {
  const { ctx, runtime, settingsKey, create, register, unregister, tools, label, safeRegister } = spec

  let disposer = null
  let lastEnabled = null

  function apply() {
    const enabled = !!settingsKey(runtime.get())
    if (enabled === lastEnabled) return
    lastEnabled = enabled
    if (enabled) {
      if (disposer === null) {
        try {
          const d = register(create())
          disposer = (typeof d === 'function') ? d : null
        } catch (e) {
          loggerWarn(ctx, label, e)
        }
      }
    } else {
      if (disposer !== null) {
        try { disposer() } catch { /* ignore */ }
        disposer = null
      } else if (typeof unregister === 'function') {
        try { unregister() } catch { /* ignore */ }
      }
    }
  }

  const stop = watchRuntime(ctx, runtime, apply, label)

  // Run initial reconciliation, then bind teardown.
  safeRegister(() => {
    apply()
    return () => {
      try { stop && stop() } catch { /* ignore */ }
      if (disposer !== null) {
        try { disposer() } catch { /* ignore */ }
        disposer = null
      }
    }
  })
}

/**
 * Subscribe to runtime settings updates. Three paths:
 *   1. Live SettingsScope.watch(handler) — legacy host seam (DSH <= 0.1.6).
 *   2. settings.on('change', …) — unit-test seam only.
 *   3. Cordis volatile reload — modern host seam (DSH >= 0.1.7): a settings
 *      edit writes into the existing volatile references and emits
 *      `loader/volatile-update` (no fiber restart); a profile-patch rewrite
 *      emits `app-boot/config-reload`. Both simply re-read the live ref.
 *
 * @param {any} ctx
 * @param {{ get: () => any }} runtime
 * @param {(next: any) => void} handler
 * @param {string} label
 */
function watchRuntime(ctx, runtime, handler, label) {
  const settings = (ctx && typeof ctx.get === 'function') ? ctx.get('settings') : null
  if (settings && typeof settings.watch === 'function') {
    try {
      return settings.watch((next) => {
        try {
          runtime.replace(next)
          handler(next)
        } catch (e) {
          loggerWarn(ctx, label, e)
        }
      })
    } catch (e) {
      loggerWarn(ctx, label, e)
      return null
    }
  }
  if (settings && typeof settings.on === 'function') {
    let off = null
    try {
      off = settings.on('change', (evt) => {
        if (!evt || evt.namespace !== SETTINGS_NAMESPACE) return
        try {
          const next = (typeof settings.get === 'function') ? (settings.get(SETTINGS_NAMESPACE) || {}) : {}
          runtime.replace(next)
          handler(next)
        } catch (e) {
          loggerWarn(ctx, label, e)
        }
      })
    } catch (e) {
      loggerWarn(ctx, label, e)
    }
    return typeof off === 'function' ? off : null
  }
  if (ctx && typeof ctx.on === 'function') {
    const fire = () => {
      try {
        handler(runtime.get())
      } catch (e) {
        loggerWarn(ctx, label, e)
      }
    }
    const offs = []
    for (const event of ['loader/volatile-update', 'app-boot/config-reload']) {
      try {
        const off = ctx.on(event, fire)
        if (typeof off === 'function') offs.push(off)
      } catch { /* that event is not observable here */ }
    }
    return offs.length > 0 ? () => { for (const off of offs) { try { off() } catch { /* ignore */ } } } : null
  }
  return null
}

function loggerWarn(ctx, label, e) {
  try {
    const log = (typeof ctx.get === 'function') ? ctx.get('logger') : null
    if (log && typeof log.warn === 'function') {
      log.warn('web-access-chain.apply', { phase: label }, (e && e.message ? e.message : String(e)))
    }
  } catch { /* ignore */ }
}
