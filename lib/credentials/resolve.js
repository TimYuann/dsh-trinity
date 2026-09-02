// lib/credentials/resolve.js — credential resolution facade.
//
// DSH credential seam contract (verified against the installed
// @deepseek-ai/dsh-credentials + @deepseek-ai/dsh-credentials-local):
//
//   ctx.credentials.resolve(ref)   → Promise<{ value, source } | undefined>
//   ctx.credentials.describe(ref)  → Promise<{ configured, source?, writable }>
//   ctx.credentials.set(ref, value)→ Promise<void>   (durable store)
//   ctx.credentials.unset(ref)     → Promise<void>
//
// `ref` is a plain POSIX identifier — an environment-variable NAME such as
// `EXA_API_KEY`. Resolution layers: inherited process env (wins) → the
// provider-managed store (~/.dsh/.credentials.yaml) → DSH's own .env
// files (project/user). A plugin must NEVER resolve with an object
// argument ({ key }) or a dotted ref — the seam brands refs by grammar.
//
// This plugin's canonical credential refs are therefore env-var names:
//   - slot 1:  <PROVIDER>_API_KEY        (e.g. EXA_API_KEY)
//   - slot N:  <PROVIDER>_API_KEY_N      (e.g. EXA_API_KEY_2) for key rotation
//   - searxng: SEARXNG_HOST              (a URL, not a key)
//
// v2.2: replaced the v2.0/v2.1 `webAccessChain_<provider>_<slot>` ref
// space (which never matched the seam grammar and silently resolved to
// nothing) with env-name refs.

/**
 * Canonical credential ref for one provider slot. Slot 1 is the bare
 * env name; slots ≥ 2 append `_<N>` so the DSH seam's POSIX grammar
 * still accepts them.
 *
 * @param {string} providerId  e.g. 'exa'
 * @param {number} slot        1-based
 * @returns {string} e.g. 'EXA_API_KEY' | 'EXA_API_KEY_2'
 */
export function providerCredentialRef(providerId, slot) {
  const base = providerIdToEnvName(providerId)
  if (!base) return ''
  const n = Math.max(1, Math.floor(Number(slot) || 1))
  return n <= 1 ? base : `${base}_${n}`
}

/**
 * @param {string} providerId
 */
export function providerIdToEnvName(providerId) {
  // Most providers map PROVIDER → <PROVIDER>_API_KEY.
  // Special cases: searxng uses SEARXNG_HOST (URL, not key), gemini can use
  // GEMINI_API_KEY or ADC.
  if (providerId === 'searxng') return 'SEARXNG_HOST'
  return providerId.toUpperCase().replace(/-/g, '_') + '_API_KEY'
}

/**
 * Resolve every credential slot for one provider through the real DSH
 * credentials seam. Returns a map keyed by the canonical CredentialRef
 * (`EXA_API_KEY`, `EXA_API_KEY_2`, …) → { key, source, raw } | null.
 *
 * The seam's `resolve(ref)` already layers process env → managed store →
 * .env files, so this function only ever talks to `ctx.credentials`.
 *
 * @param {string} providerId
 * @param {any} ctx
 * @param {number} [maxKeys]
 * @returns {Promise<Record<string, { key: string, source: string, raw: string } | null>>}
 */
export async function resolveCredentialPool(providerId, ctx, maxKeys = 3) {
  /** @type {Record<string, { key: string, source: string, raw: string } | null>} */
  const out = {}
  const slots = Math.max(1, Math.min(10, maxKeys || 3))
  const credentials = (ctx && typeof ctx.get === 'function') ? ctx.get('credentials') : null
  const envName = providerIdToEnvName(providerId)
  if (!envName) return out

  for (let i = 1; i <= slots; i++) {
    const ref = providerCredentialRef(providerId, i)
    let resolved = null
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        // The DSH seam takes the env-name STRING directly.
        const r = await credentials.resolve(ref)
        if (r && typeof r === 'object' && typeof r.value === 'string' && r.value.length > 0) {
          resolved = { key: r.value, source: r.source || 'credentials', raw: ref }
        }
      } catch {
        // ignore — resolution must never crash the chain
      }
    }
    out[ref] = resolved
  }
  return out
}

/**
 * Resolve ONE env-name credential through the seam, falling back to the
 * process environment for contexts without a credentials service (tests,
 * headless tool paths). Used by the gated extract tools (pdf/video).
 *
 * @param {any} ctx
 * @param {string} envName  e.g. 'GEMINI_API_KEY'
 * @returns {Promise<string | null>}
 */
export async function resolveEnvCredential(ctx, envName) {
  if (!envName) return null
  const credentials = (ctx && typeof ctx.get === 'function') ? ctx.get('credentials') : null
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const r = await credentials.resolve(envName)
      if (r && typeof r === 'object' && typeof r.value === 'string' && r.value.length > 0) {
        return r.value
      }
    } catch {
      // fall through to process env
    }
  }
  const v = process.env[envName]
  return (typeof v === 'string' && v.length > 0) ? v : null
}

/**
 * Return the `authFetch` profile matching `profileName` from the resolved
 * settings, or undefined. Used by safeFetch to apply credentials per
 * Origin.
 *
 * @param {string} profileName
 * @param {any} settings  resolved web-access-chain settings object
 */
export function getAuthFetchProfile(profileName, settings) {
  if (!profileName || !settings || typeof settings !== 'object') return undefined
  const profiles = settings.authFetch
  if (!profiles || typeof profiles !== 'object') return undefined
  const p = profiles[profileName]
  if (!p || typeof p !== 'object') return undefined
  if (typeof p.valueRef !== 'string') return undefined
  return {
    name: profileName,
    type: p.type,
    valueRef: p.valueRef,
    allowedOrigins: Array.isArray(p.allowedOrigins) ? p.allowedOrigins.slice() : [],
  }
}

/**
 * Decide whether an origin is allowed by an authFetch profile's
 * allowedOrigins list (SPEC §II.7 — credentials are stripped on cross-
 * Origin redirect).
 *
 * @param {string} origin        // e.g. 'https://example.com'
 * @param {string[]} allowedList // exact-match origins
 * @returns {boolean}
 */
export function originAllowed(origin, allowedList) {
  if (!origin || !Array.isArray(allowedList) || allowedList.length === 0) return false
  for (const a of allowedList) {
    if (typeof a !== 'string') continue
    if (a === origin) return true
  }
  return false
}
