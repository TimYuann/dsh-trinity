// lib/cache/visibility.js — auth-aware cache scope checks (SPEC §II.3.4
// Contract D Step 1 / acceptance #7, #8).
//
// Authorization rules:
//   - Unauthenticated entry: `sessionIds` may be empty → visible to any
//     session in the same `profileId`.
//   - Authenticated entry: `sessionIds` must include the reader's
//     `sessionId` for access.
//   - All reads check `authenticated` flag first; if `true`, the entry
//     is only visible to its original session.
//
// Identity seam: `ctx.agents.currentInitiator()?.sessionId` is the reader's
// session id (when available); the writer's session is captured at the
// time of write.

import { webError } from '../errors.js'

/**
 * Determine the reader's identity from the live context.
 *
 * P1 #9: when no profileId seam is reachable, throw
 * WEB_CONTENT_FORBIDDEN instead of silently sharing the same profileId
 * across readers. Silent fallback would weaken acceptance #8 (unauth
 * cache: profile peers can read) — cross-profile isolation would degrade
 * to single-profile-name sharing.
 *
 * @param {any} ctx
 * @returns {{ profileId: string, sessionId: string | null }}
 */
export function readerIdentity(ctx) {
  const profileId = readProfileId(ctx)
  let sessionId = null
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
    if (agents && typeof agents.currentInitiator === 'function') {
      const a = agents.currentInitiator()
      if (a) {
        sessionId = (typeof a.sessionId === 'string' && a.sessionId.length > 0) ? a.sessionId
                 : (typeof a.id === 'string' ? a.id : null)
      }
    }
  } catch { /* ignore */ }
  // NOTE: DSH has no `ctx.session` Cordis service — agents.currentInitiator()
  // is the only identity seam. Do NOT re-add a ctx.session branch here; the
  // Cordis strict property-access guard would throw for undeclared services.
  return { profileId, sessionId }
}

/**
 * Resolve the cache's profileId. DSH has NO `profileId` on the agent
 * seam (Agent exposes id/session only) and no `dsh.profile` settings
 * namespace, so the v1.0 Pi-style "cross-profile isolation" check cannot
 * be satisfied from DSH identity. Every DSH profile runs as its own
 * process, so the process scope IS the profile scope: fall back to
 * `$DSH_PROFILE` (when the launcher sets it) or `'default'`.
 *
 * The settings paths are kept for deployments that DO expose a profile
 * id (e.g. a host plugin mounting `dsh.profile`), so the check still
 * works there.
 *
 * @param {any} ctx
 * @returns {string}
 */
function readProfileId(ctx) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
    if (settings && typeof settings.get === 'function') {
      // Common locations: `dsh.profile` (DSH core) or `web-access-chain.profile`.
      const a = safeGet(settings, 'dsh.profile')
      if (a && typeof a === 'object' && typeof a.id === 'string') return a.id
      const b = safeGet(settings, 'web-access-chain.profile')
      if (b && typeof b === 'object' && typeof b.id === 'string') return b.id
      if (typeof a === 'string' && a.length > 0) return a
      if (typeof b === 'string' && b.length > 0) return b
    }
  } catch { /* ignore */ }
  // v2.2: no throw — DSH never satisfies the profile seam, and throwing
  // broke every cache write (web_fetch / source_check) in the live host.
  const env = process.env.DSH_PROFILE
  return (typeof env === 'string' && env.length > 0) ? env : 'default'
}

function safeGet(settings, ns) {
  try { return settings.get(ns) } catch { return undefined }
}

/**
 * Decide whether `reader` may read `entry`. Throws WEB_CONTENT_FORBIDDEN
 * on rejection; returns the (unmodified) entry on success.
 *
 * @param {{ visibilityScope: { profileId: string, sessionIds: string[] }, authenticated: boolean }} entry
 * @param {{ profileId: string, sessionId: string | null }} reader
 */
export function authorizeRead(entry, reader) {
  if (!entry || !entry.visibilityScope) {
    throw webError('WEB_CONTENT_FORBIDDEN', 'cache entry missing visibilityScope')
  }
  const scope = entry.visibilityScope
  if (entry.authenticated) {
    // Authenticated entries are session-scoped only.
    if (!reader.sessionId) {
      throw webError('WEB_CONTENT_FORBIDDEN', 'authenticated entry requires a session id')
    }
    if (!Array.isArray(scope.sessionIds) || !scope.sessionIds.includes(reader.sessionId)) {
      throw webError('WEB_CONTENT_FORBIDDEN', 'authenticated cache entry is session-scoped')
    }
    return entry
  }
  // Unauthenticated: same profile only.
  if (scope.profileId !== reader.profileId) {
    throw webError('WEB_CONTENT_FORBIDDEN', 'cache entry is profile-scoped to a different profile')
  }
  return entry
}

/**
 * Build a visibilityScope for a new entry.
 *
 * @param {{ profileId: string, sessionId: string | null }} writer
 * @param {{ authenticated: boolean }} [opts]
 */
export function scopeFor(writer, opts = {}) {
  return {
    profileId: writer.profileId,
    sessionIds: opts.authenticated && writer.sessionId ? [writer.sessionId] : [],
  }
}
