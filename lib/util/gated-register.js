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
// This helper subscribes once to the live `SettingsScope.watch(...)`
// from `lib/settings/register.js` and reconciles:
//
//   | Previous | Next | Action                          |
//   |----------|------|---------------------------------|
//   | false    | false | none                            |
//   | false    | true  | register once                   |
//   | true     | true  | none (idempotent)               |
//   | true     | false | dispose once                    |
//
// It also disposes any active registration on plugin teardown.

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
 * Subscribe to runtime settings updates. Two paths:
 *   1. Live SettingsScope.watch(handler) — canonical seam (preferred).
 *   2. settings.on('change', …) — kept for unit-test seam only.
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
