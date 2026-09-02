// lib/credentials/last-error.js — single source of truth for the
// `lastError` data clump (P3 #24).
//
// Both `lib/providers/search/chained.js` (writer) and
// `lib/doctor/probe.js` (reader) need to agree on the shape. The fields
// below are the only ones any consumer should depend on.

/**
 * @typedef {{
 *   providerId: string,
 *   class: string,                 // ErrorClass from lib/classify-error.js
 *   credentialRef: string | null,
 *   credentialMode: ('none' | 'pool' | 'host') | undefined,
 *   cooldownUntil: number | undefined,
 *   at: number,                     // ms epoch
 * }} LastError
 */

/**
 * Build a LastError from the inputs we collect per provider.
 *
 * @param {string} providerId
 * @param {string} errorClass
 * @param {{ credentialRef?: string | null, credentialMode?: ('none' | 'pool' | 'host'), cooldownUntil?: number }} [opts]
 * @returns {LastError}
 */
export function makeLastError(providerId, errorClass, opts = {}) {
  return {
    providerId,
    class: errorClass,
    credentialRef: opts.credentialRef || null,
    credentialMode: opts.credentialMode,
    cooldownUntil: opts.cooldownUntil,
    at: Date.now(),
  }
}

/**
 * @param {any} value
 * @returns {value is LastError}
 */
export function isLastError(value) {
  return value && typeof value === 'object'
    && typeof value.providerId === 'string'
    && typeof value.class === 'string'
    && typeof value.at === 'number'
}
