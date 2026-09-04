// lib/providers/search/select-routing.js — the one and only routing
// parser (SPEC §I.4 #17).
//
// web_search_ex passes the raw `routing` argument unchanged. This module
// is the single point that turns a raw routing value into the canonical
// shape the chain executor consumes:
//
//   'auto'                                          → 'auto'
//   'aggregate'                                     → 'aggregate'
//   <known provider id>                             → { kind: 'single', id }
//   <ordered list of known provider ids>            → { kind: 'ordered', ids }
//
// Strictness rules (per v2.3.0 § Commit 2):
//   - empty explicit string  → throw WEB_PROVIDER_BAD_REQUEST
//   - unknown provider id    → throw WEB_PROVIDER_BAD_REQUEST
//   - 'auto' / 'aggregate' as array elements → throw
//   - duplicate ids are de-duplicated WITHOUT reordering
//   - one-element array collapses to { kind: 'single', id }
//
// Errors are surfaced as Error objects with code 'WEB_PROVIDER_BAD_REQUEST'
// and an actionable `advice` (string).

const BAD_REQUEST = 'WEB_PROVIDER_BAD_REQUEST'

/**
 * Parse a raw routing value into the canonical shape, against the
 * authoritative provider set. `knownIds` must be the full list of valid
 * provider ids from the canonical Provider Metadata (Commit 4). The
 * function refuses any id outside the set rather than silently degrading
 * the operator's intent.
 *
 * @param {unknown} routing
 * @param {{ knownIds: string[] }} opts
 * @returns {'auto' | 'aggregate' | { kind: 'single', id: string } | { kind: 'ordered', ids: string[] }}
 */
export function selectRouting(routing, opts) {
  const knownIds = (opts && Array.isArray(opts.knownIds)) ? new Set(opts.knownIds) : new Set()
  const valid = (s) => knownIds.size === 0 || knownIds.has(s)

  if (routing === undefined || routing === null || routing === 'auto') return 'auto'
  if (routing === 'aggregate') return 'aggregate'

  if (typeof routing === 'string') {
    const id = routing.trim()
    if (id.length === 0) {
      throw badRequest('routing string is empty', "pass 'auto', 'aggregate', or a known provider id")
    }
    if (!valid(id)) {
      throw badRequest(`unknown provider id '${id}'`,
        "pass one of the IDs returned by `web_doctor().providers[].id`, e.g. 'exa' or 'tavily'")
    }
    return { kind: 'single', id }
  }

  if (Array.isArray(routing)) {
    if (routing.length === 0) {
      throw badRequest('routing array is empty',
        "pass a non-empty list of provider ids, e.g. ['exa', 'tavily']")
    }
    const seen = new Set()
    const ids = []
    for (const item of routing) {
      if (typeof item !== 'string') {
        throw badRequest(`routing array element must be a string (got ${typeof item})`,
          "pass provider ids as strings, e.g. ['exa', 'tavily']")
      }
      const id = item.trim()
      if (id.length === 0) {
        throw badRequest('routing array contains an empty string',
          "pass non-empty provider ids, e.g. ['exa', 'tavily']")
      }
      if (id === 'auto' || id === 'aggregate') {
        throw badRequest(`'${id}' is not a valid routing-array element`,
          "drop the auto/aggregate entries; pass only provider ids in the array")
      }
      if (!valid(id)) {
        throw badRequest(`unknown provider id '${id}' in routing array`,
          "pass only provider ids returned by `web_doctor().providers[].id`")
      }
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    if (ids.length === 1) return { kind: 'single', id: ids[0] }
    return { kind: 'ordered', ids }
  }

  throw badRequest(`routing must be 'auto', 'aggregate', a provider id, or an array of provider ids (got ${typeof routing})`,
    "pass routing='auto' | 'aggregate' | '<providerId>' | ['exa','tavily',...]")
}

function badRequest(message, advice) {
  const e = new Error(`routing rejected: ${message} | TRY: ${advice}`)
  e.code = BAD_REQUEST
  e.advice = advice
  return e
}
