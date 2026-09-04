// lib/credentials/pool.js — CredentialEntry state machine + Pool runner
// (SPEC §II.3.3 Contract C).
//
// Two-level fallback. For each provider, build a CredentialPool of N
// `CredentialEntry`s (capped by `maxKeysPerProvider`), then drive the
// decision table:
//
//   2xx + sources         → healthy, return
//   429 / quota / limit   → quotaCooldown, next credential
//   401 / confirmed auth  → invalid, next credential
//   missing credentialRef → next credentialRef
//   5xx / network         → retry THIS credential once with perKeyTimeoutMs
//   invalid-response      → next provider (no key drain)
//   abort                 → abort entire chain
//   security / SSRF       → throw

import { createHash } from 'node:crypto'
import { classifyError, isKeyRetryable, isFallbackable, quotaCooldownMs, withClass } from '../classify-error.js'
import { redactAllCredentials } from '../key-redact.js'
import { providerCredentialRef } from './resolve.js'
import { createBudgetController } from '../util/budget-controller.js'

/**
 * Number of times a single credential is retried after a transient /
 * network failure before the runner moves to the next credential
 * (SPEC §II.3.3 "5xx / network / timeout → retry THIS credential once with
 * `perKeyTimeoutMs`").
 *
 * P2 #20: extracted from a magic literal; the runner's `for (let attempt
 * = 0; attempt <= KEY_RETRY_ONCE; attempt++)` makes the intent explicit.
 */
export const KEY_RETRY_ONCE = 1

/**
 * @typedef {'unknown' | 'healthy' | 'quotaCooldown' | 'invalid'} CredentialState
 */

/**
 * @typedef {object} CredentialEntry
 * @property {string} credentialRef
 * @property {CredentialState} state
 * @property {number} [cooldownUntil]   // ms epoch; only when state === 'quotaCooldown'
 * @property {string} [lastErrorClass]  // e.g. 'quota' | 'auth'
 */

/**
 * Build the initial CredentialEntry[] for one provider. Slot order is
 * defined by CREDENTIAL_SLOTS_PER_PROVIDER. Entries whose credentialRef is
 * unresolved are dropped (the chain still tries the provider once with
 * skipMissingRef semantics).
 *
 * v2.3.0 § Commit 4.4: prior process-local pool state is reused when
 * the resolved-key fingerprint matches a prior entry's. This ensures
 * quota cooldown + invalid status survive across sequential requests
 * without per-call rebuilds discarding them. A fingerprint change
 * (key rotation under the same ref) resets the entry to 'unknown'.
 *
 * @param {string} providerId
 * @param {{ resolved: Record<string, { key: string, source: string, raw: string } | null> }} loaded
 * @param {number} maxKeys
 * @param {CredentialEntry[]} [priorState]
 * @returns {CredentialEntry[]}
 */
export function buildPool(providerId, loaded, maxKeys = 3, priorState) {
  const slots = Math.max(1, Math.min(10, maxKeys || 3))
  const priorByRef = new Map()
  if (Array.isArray(priorState)) {
    for (const e of priorState) {
      if (e && e.credentialRef) priorByRef.set(e.credentialRef, e)
    }
  }
  const out = []
  for (let i = 1; i <= slots; i++) {
    const credentialRef = providerCredentialRef(providerId, i)
    const resolved = (loaded && loaded.resolved) ? loaded.resolved[credentialRef] : null
    if (!resolved || !resolved.key) {
      out.push({ credentialRef, state: 'unknown' })
      continue
    }
    const fingerprint = fingerprintOf(resolved.key)
    const prior = priorByRef.get(credentialRef)
    if (prior && prior.fingerprint === fingerprint && prior.state && prior.state !== 'unknown') {
      out.push({
        credentialRef,
        state: prior.state,
        cooldownUntil: prior.cooldownUntil,
        lastErrorClass: prior.lastErrorClass,
        fingerprint,
      })
      continue
    }
    out.push({ credentialRef, state: 'unknown', fingerprint })
  }
  return out
}

function fingerprintOf(secret) {
  try { return createHash('sha256').update(String(secret)).digest('hex') }
  catch { return '' }
}

/**
 * Apply the §II.3.3 outcome → state transition. Pure function — does not
 * mutate the entry.
 *
 * @param {CredentialEntry} entry
 * @param {string} errorClass
 * @param {number} [retryAfterMs]
 * @returns {CredentialEntry}
 */
export function transitionState(entry, errorClass, retryAfterMs) {
  if (errorClass === 'quota') {
    return {
      ...entry,
      state: 'quotaCooldown',
      cooldownUntil: Date.now() + (retryAfterMs != null ? retryAfterMs : 60_000),
      lastErrorClass: 'quota',
    }
  }
  if (errorClass === 'auth') {
    return { ...entry, state: 'invalid', lastErrorClass: 'auth' }
  }
  // transient / network / invalid-response / unknown → no state change
  return { ...entry, lastErrorClass: errorClass }
}

/**
 * Skip a credential with cooldown not yet expired. Returns the entry
 * unchanged if its cooldown has elapsed (caller may retry).
 *
 * @param {CredentialEntry} entry
 * @param {number} now
 * @returns {CredentialEntry}
 */
export function clearExpiredCooldown(entry, now) {
  if (entry.state === 'quotaCooldown' && typeof entry.cooldownUntil === 'number' && entry.cooldownUntil <= now) {
    return { ...entry, state: 'unknown', cooldownUntil: undefined, lastErrorClass: undefined }
  }
  return entry
}

/**
 * Run a pool of credentials against one provider. Implements the SPEC
 * §II.3.3 decision table: each credential is tried once; on 5xx / network
 * the same credential is retried once with `perKeyTimeoutMs`; on quota /
 * auth, mark the credential and move on; on success, mark healthy and
 * return.
 *
 * @template T
 * @param {{
 *   providerId: string,
 *   pool: CredentialEntry[],
 *   maxKeys: number,
 *   perKeyTimeoutMs: number,
 *   keysForRedaction: string[],
 *   fetch: (credentialRef: string | null, signal: AbortSignal | undefined, pickedCredential: string | null) => Promise<T>,
 *   signal: AbortSignal | undefined,
 *   onPoolUpdated?: (pool: CredentialEntry[]) => void,
 * }} args
 * @returns {Promise<{ ok: true, value: T, pool: CredentialEntry[] } | { ok: false, class: string, attempts: Array<{ credentialRef: string | null, class: string }>, pool: CredentialEntry[] }>}
 */
export async function runPool(args) {
  const pool = args.pool.slice()
  const attempts = []
  const now = Date.now()

  for (let i = 0; i < pool.length; i++) {
    // Check for abort at the top of each iteration.
    if (args.signal && args.signal.aborted) {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      throw e
    }
    let entry = clearExpiredCooldown(pool[i], now)

    // Skip invalid entries (auth-failed) permanently — they have no
    // prospect of recovery without new credentials.
    if (entry.state === 'invalid') {
      attempts.push({ credentialRef: entry.credentialRef, class: 'auth' })
      continue
    }

    // Skip entries in cooldown unless the cooldown has elapsed (handled
    // above).
    if (entry.state === 'quotaCooldown') {
      attempts.push({ credentialRef: entry.credentialRef, class: 'quotaCooldown' })
      continue
    }

    // Try this credential. May retry once on transient / network.
    // v2.3.0: each attempt gets its own BudgetController that wires
    // perKeyTimeoutMs to an AbortSignal. The signal is handed to the
    // fetch closure, so a slow provider actually observes the abort.
    let lastErr = null
    for (let attempt = 0; attempt <= KEY_RETRY_ONCE; attempt++) {
      const ctl = createBudgetController({
        parentSignal: args.signal,
        timeoutMs: args.perKeyTimeoutMs,
        timeoutClass: 'budget',
      })
      try {
        const value = await args.fetch(entry.credentialRef, ctl ? ctl.signal : args.signal, entry.credentialRef)
        // Success — mark healthy.
        pool[i] = { ...entry, state: 'healthy', lastErrorClass: undefined, cooldownUntil: undefined }
        args.onPoolUpdated?.(pool)
        return { ok: true, value, pool }
      } catch (err) {
        const cls = classifyError(err)
        // Honor explicit class attachment if the caller provided one.
        const effective = (err && typeof err === 'object' && typeof err.class === 'string') ? err.class : cls
        const errMsg = (err && typeof err === 'object' && typeof err.message === 'string') ? err.message : String(err)
        const safeMsg = redactAllCredentials(errMsg, args.keysForRedaction)
        lastErr = withClass(Object.assign(new Error(safeMsg), { name: (err && err.name) || 'Error' }), effective)

        if (effective === 'aborted') {
          throw lastErr
        }
        if (effective === 'security' || effective === 'config' || effective === 'invalid-request') {
          throw lastErr
        }
        if (effective === 'auth') {
          pool[i] = transitionState(entry, 'auth')
          attempts.push({ credentialRef: entry.credentialRef, class: 'auth' })
          lastErr = null
          break
        }
        if (effective === 'quota') {
          const cd = quotaCooldownMs('quota', err) || 60_000
          pool[i] = transitionState(entry, 'quota', cd)
          attempts.push({ credentialRef: entry.credentialRef, class: 'quotaCooldown' })
          lastErr = null
          break
        }
        if (effective === 'credential') {
          attempts.push({ credentialRef: entry.credentialRef, class: 'credential' })
          lastErr = null
          break
        }
        if (isKeyRetryable(effective) && attempt === 0) {
          continue
        }
        if (effective === 'invalid-response') {
          attempts.push({ credentialRef: entry.credentialRef, class: 'invalid-response' })
        } else if (effective === 'transient' || effective === 'network') {
          attempts.push({ credentialRef: entry.credentialRef, class: effective })
        } else if (effective === 'budget') {
          attempts.push({ credentialRef: entry.credentialRef, class: 'budget' })
          args.onPoolUpdated?.(pool)
          return { ok: false, class: 'budget', attempts, pool }
        } else {
          attempts.push({ credentialRef: entry.credentialRef, class: effective })
        }
        lastErr = null
        break
      } finally {
        if (ctl) ctl.dispose()
      }
    }
    if (lastErr) {
      // Should not happen given the branch above always clears lastErr on
      // a recognized outcome. Defensive: surface as the latest class.
      attempts.push({ credentialRef: entry.credentialRef, class: classifyError(lastErr) })
    }
    args.onPoolUpdated?.(pool)
  }

  // Pool exhausted without a success.
  return {
    ok: false,
    class: attempts.length > 0 ? attempts[attempts.length - 1].class : 'credential',
    attempts,
    pool,
  }
}

/**
 * Pretty-print a CredentialPool summary for the doctor. Counts are derived
 * from the current entry states.
 *
 * @param {CredentialEntry[]} pool
 * @returns {{ configured: number, healthy: number, cooldown: number, invalid: number, unknown: number }}
 */
export function poolSummary(pool) {
  const out = { configured: 0, healthy: 0, cooldown: 0, invalid: 0, unknown: 0 }
  if (!Array.isArray(pool)) return out
  for (const e of pool) {
    if (!e || !e.credentialRef) continue
    out.configured++
    if (e.state === 'healthy') out.healthy++
    else if (e.state === 'quotaCooldown') out.cooldown++
    else if (e.state === 'invalid') out.invalid++
    else out.unknown++
  }
  return out
}
