// lib/util/gated-register.js — settings-driven Tool registration
// (R3 P0 #6, P3 #24).
//
// Each gated Tool reads a single `settings.tools.<name>.enabled` flag.
// The naive approach (read flag once at apply() time) means runtime
// changes require a profile reload. We instead wrap the registration
// inside `ctx.effect(...)` keyed on a settings change subscription so
// `web-access-chain.tools.<name>.enabled = true` toggles registration
// without restarting the plugin.

import { SETTINGS_NAMESPACE } from '../config-schema.js'

/**
 * Register a Tool when `settingsKey(settings)` is truthy. When the
 * settings store exposes an `on('change', ...)` hook, the registration
 * re-runs on every change, so operators can flip the gate at runtime.
 *
 * @param {{
 *   ctx: any,
 *   settings: any,
 *   settingsKey: (settings: any) => boolean,
 *   create: () => any,
 *   tools: any,                  // DSH tools service
 *   register: (t: any) => any,   // tools.register
 *   label: string,               // for logging
 *   safeRegister: (fn: () => any) => any,
 * }} spec
 */
export function registerIfEnabled(spec) {
  const { ctx, settings, settingsKey, create, register, label, safeRegister } = spec
  // R3 P0 #6 fix: do NOT short-circuit when the initial gate is closed.
  // We always subscribe to settings change so an operator can flip the
  // gate at runtime (the whole point of the helper). The initial
  // registration below is also conditional on the gate, so disabled
  // tools stay disabled until the change event fires.
  const settingsSvc = (typeof ctx.get === 'function') ? ctx.get('settings') : null
  if (settingsSvc && typeof settingsSvc.on === 'function') {
    safeRegister(() => {
      const disposeChange = settingsSvc.on('change', (evt) => {
        try {
          if (evt && evt.namespace === SETTINGS_NAMESPACE) {
            if (settingsKey(readSettingsSnapshot(ctx))) {
              try { register(create()) } catch (e) {
                loggerWarn(ctx, label, e)
              }
            }
          }
        } catch (e) {
          loggerWarn(ctx, label, e)
        }
      })
      return () => { try { disposeChange && disposeChange() } catch { /* ignore */ } }
    })
  }
  // Initial registration — gated, not always-on.
  if (settingsKey(settings)) {
    safeRegister(() => {
      try {
        return register(create())
      } catch (e) {
        loggerWarn(ctx, label, e)
        return () => {}
      }
    })
  }
}

function readSettingsSnapshot(ctx) {
  try {
    const s = (typeof ctx.get === 'function') ? ctx.get('settings') : null
    if (s && typeof s.get === 'function') return s.get(SETTINGS_NAMESPACE) || {}
  } catch { /* ignore */ }
  return {}
}

function loggerWarn(ctx, label, e) {
  try {
    const log = (typeof ctx.get === 'function') ? ctx.get('logger') : null
    if (log && typeof log.warn === 'function') {
      log.warn('web-access-chain.apply', { phase: label }, e && e.message ? e.message : String(e))
    }
  } catch { /* ignore */ }
}