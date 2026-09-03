// lib/credentials/web-ui-validation.js — client-side validation for the
// v2.2.3 Web UI Provider Key Settings card.
//
// Why this lives in the host-bundle package rather than the client
// bundle: the Web UI client (`lib/client.js`) imports this module so the
// browser half and the slash command (`/webdoctor-keys`) share one
// validation surface. Two validators diverging is the easiest way to
// accept a placeholder today and reject it tomorrow.
//
// Hard rules enforced here (browser only — the host DSH credential
// seam does its own reference-grammar validation when `set` lands):
//   - Provider id must be in ALL_PROVIDER_IDS.
//   - Value must be a non-empty string.
//   - Value must not be a known placeholder ("your-key", "xxx", …).
//   - Value must be at least 8 chars long (every real provider's keys
//     exceed this floor; anything shorter is almost always a paste mistake).
//
// The browser side computes `last4` from the value the user types and
// passes it through the component state ONLY — it never round-trips
// to the host, never appears in a log line, never lives in settings.
//
// The browser never echoes a placeholder into its own UI state. The
// validation surface returns a stable `code` token so the React
// component can map it to a localised string without trusting a
// possibly-host-supplied message.

import { ALL_PROVIDER_IDS } from '../config-schema.js'
import { providerIdToEnvName } from './resolve.js'

export { ALL_PROVIDER_IDS }

/** Lower-case placeholder tokens the Web UI rejects before submit. */
const PLACEHOLDER_TOKENS = new Set([
  'your-key', 'xxx', 'dummy', 'null', 'undefined', 'changeme',
  'placeholder', 'todo', 'fixme', 'replace-me', 'replace_me',
  'example', 'sample', 'test',
])

/** Provider id allowlist = the union of every slot we ever register. */
export function isValidProvider(id) {
  return typeof id === 'string' && ALL_PROVIDER_IDS.includes(id)
}

/**
 * Validate a typed API key value. Browser-side only.
 * Returns a stable `code` token; the UI maps that token to copy.
 *
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, code: string, message: string }}
 */
export function validateKeyValue(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'bad-shape', message: 'key must be a string' }
  }
  if (value.length === 0) return { ok: false, code: 'empty', message: 'key is required' }
  if (value.trim().length === 0) return { ok: false, code: 'empty', message: 'key is required' }
  const lower = value.trim().toLowerCase()
  if (PLACEHOLDER_TOKENS.has(lower)) {
    // Do NOT echo the placeholder; only say something is wrong.
    return { ok: false, code: 'placeholder', message: 'that looks like a placeholder' }
  }
  if (value.length < 8) {
    return { ok: false, code: 'too-short', message: 'that key is too short' }
  }
  return { ok: true, value }
}

/**
 * Validate a credential reference (the env-var id).
 *
 * @param {unknown} ref
 * @returns {{ ok: true, value: string } | { ok: false, code: string, message: string }}
 */
export function validateRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return { ok: false, code: 'bad-shape', message: 'ref must be a non-empty string' }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    return { ok: false, code: 'bad-shape', message: 'ref must be a POSIX environment-variable identifier' }
  }
  return { ok: true, value: ref }
}

/**
 * The env-var name for `provider` — the DSH credentials seam keys
 * every entry under an env-name ref (`EXA_API_KEY`, `GEMINI_API_KEY`,
 * `SEARXNG_HOST`).
 *
 * @param {string} provider
 * @returns {string}
 */
export function envNameForProvider(provider) {
  return providerIdToEnvName(provider)
}

/**
 * Compute `last4` of a typed value. Browser-side helper, used to display
 * the trailing fingerprint the moment the user clicks Save — never
 * persisted across page reloads, never sent over the wire.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function clientLast4(value) {
  if (typeof value !== 'string') return null
  if (value.length < 8) return null
  const trimmed = value.trim()
  if (trimmed.length < 8) return null
  const lower = trimmed.toLowerCase()
  if (PLACEHOLDER_TOKENS.has(lower)) return null
  return value.slice(-4)
}