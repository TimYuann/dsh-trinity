// lib/util/capabilities.js — canonical adapter capability envelope
// (R3 P3 #23).
//
// All adapters expose a `capabilities(ctx)` function. The locked fields
// are { tier, backends, cheap }; adapters that need runtime-derived data
// (e.g. effective maxPages) merge it via the optional `extra` callback.
//
// Centralising the shape here kills the 5× duplication reviewer flagged
// as P3 #23.

/**
 * @typedef {{ tier: number, backends: string[], cheap: boolean }} CapabilitiesBase
 */

/**
 * Build the canonical capabilities envelope for an adapter.
 *
 * @param {{ tier: number, backends: string[], cheap: boolean }} base
 * @param {(ctx: any) => Record<string, any> | undefined} [extra]
 * @returns {(ctx: any) => CapabilitiesBase & Record<string, any>}
 */
export function makeCapabilities(base, extra) {
  return function capabilities(ctx) {
    const out = {
      tier: base.tier,
      backends: base.backends.slice(),
      cheap: base.cheap,
    }
    if (typeof extra === 'function') {
      const e = extra(ctx)
      if (e && typeof e === 'object') Object.assign(out, e)
    }
    return out
  }
}