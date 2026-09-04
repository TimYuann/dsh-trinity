// lib/cache/index.js — single CacheModule façade used by Tools.
//
// v2.3.0 § Commit 5.3: process-local bounded cache. The index, content
// bytes, and the lifecycle all share one Map. After a process restart
// the cacheRef cannot be resolved — this is now documented as a
// process-local snapshot (not a durable snapshot).
//
// Settings:
//   * cacheTtlMs      — 0 means "no time expiry before process exit".
//                      Positive values expire after `age > ttlMs`.
//   * cacheMaxEntries — soft entry cap (oldest-first eviction).
//   * cacheMaxBytes   — soft byte cap (oldest-first eviction).
//
// An entry whose byte size alone would exceed cacheMaxBytes is rejected
// at insertion rather than poisoning the cache.

import { makeCacheRef } from './cacheRef.js'
import { savePayload, loadPayload, PAYLOAD_REF_INLINE } from './storage.js'
import { readerIdentity, authorizeRead, scopeFor } from './visibility.js'
import { readContent, HARD_CHAR_CAP } from './content-find.js'

/**
 * @typedef {{
 *   cacheRef: string,
 *   kind: 'search' | 'fetch' | 'page' | 'pdf' | 'video',
 *   visibilityScope: { profileId: string, sessionIds: string[] },
 *   authenticated: boolean,
 *   sourceProvider?: string,
 *   sources: any[],
 *   fetchedAt: number,
 *   ttlMs: number,
 *   contentRef?: { store: 'storage' | 'inline', ref: string, bytes: number },
 *   inlineContent?: string,
 * }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const entries = new Map()

/**
 * Read live cache settings. The function is permissive: missing
 * ctx.settings falls back to schema defaults that match v2.2.1
 * behaviour so unit-test seams (which build their own ctx) keep
 * working.
 */
function readCacheSettings(ctx) {
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
  const web = (settings && typeof settings.get === 'function') ? settings.get('web-access-chain') : null
  if (!web || typeof web !== 'object') return null
  return {
    cacheTtlMs: typeof web.cacheTtlMs === 'number' ? web.cacheTtlMs : 3_600_000,
    cacheMaxEntries: typeof web.cacheMaxEntries === 'number' ? web.cacheMaxEntries : 128,
    cacheMaxBytes: typeof web.cacheMaxBytes === 'number' ? web.cacheMaxBytes : 128 * 1024 * 1024,
  }
}

function inferSettings(input) {
  if (input && typeof input.cacheTtlMs === 'number') return input
  return null
}

/**
 * Settle an entry into the cache. Returns the assigned cacheRef.
 *
 * @param {any} ctx
 * @param {{
 *   kind: 'search' | 'fetch' | 'page' | 'pdf' | 'video',
 *   authenticated?: boolean,
 *   sourceProvider?: string,
 *   sources: any[],
 *   inlineContent?: string,
 *   ttlMs?: number,
 *   cacheTtlMs?: number,           // v2.3.0 — overrides live policy
 *   cacheMaxEntries?: number,
 *   cacheMaxBytes?: number,
 * }} input
 * @returns {Promise<{ cacheRef: string, entry: CacheEntry }>}
 */
export async function put(ctx, input) {
  const writer = readerIdentity(ctx)
  const cacheRef = makeCacheRef()
  const live = readCacheSettings(ctx)
  const override = inferSettings(input)
  const policy = {
    cacheTtlMs: override?.cacheTtlMs ?? (typeof input.ttlMs === 'number' ? input.ttlMs : null) ?? live?.cacheTtlMs ?? 3_600_000,
    cacheMaxEntries: override?.cacheMaxEntries ?? live?.cacheMaxEntries ?? 128,
    cacheMaxBytes: override?.cacheMaxBytes ?? live?.cacheMaxBytes ?? 128 * 1024 * 1024,
  }
  const scope = scopeFor(writer, { authenticated: !!input.authenticated })
  let contentRef = null
  if (typeof input.inlineContent === 'string' && input.inlineContent.length > 0) {
    contentRef = await savePayload(ctx, cacheRef, input.inlineContent, { kind: input.kind, owner: ctx })
  }
  // Per-entry cap: a single oversized entry never poisons the cache.
  if (contentRef && typeof contentRef.bytes === 'number' && contentRef.bytes > policy.cacheMaxBytes) {
    return {
      cacheRef,
      entry: {
        cacheRef,
        kind: input.kind,
        visibilityScope: scope,
        authenticated: !!input.authenticated,
        sourceProvider: input.sourceProvider,
        sources: input.sources,
        fetchedAt: Date.now(),
        ttlMs: policy.cacheTtlMs,
        contentRef,
        oversized: true,
      },
    }
  }
  const entry = {
    cacheRef,
    kind: input.kind,
    visibilityScope: scope,
    authenticated: !!input.authenticated,
    sourceProvider: input.sourceProvider,
    sources: input.sources,
    fetchedAt: Date.now(),
    ttlMs: policy.cacheTtlMs,
    contentRef: contentRef || undefined,
  }
  if (contentRef && contentRef.store === PAYLOAD_REF_INLINE && typeof input.inlineContent === 'string') {
    entry.inlineContent = input.inlineContent
  }
  entries.set(cacheRef, entry)
  evictIfNeeded(policy)
  return { cacheRef, entry }
}

/**
 * Read a cache entry by cacheRef. Throws WEB_CONTENT_FORBIDDEN on auth
 * mismatch.
 *
 * @param {any} ctx
 * @param {string} cacheRef
 * @returns {Promise<{ entry: CacheEntry, content: string | null }>}
 */
export async function get(ctx, cacheRef) {
  const e = entries.get(cacheRef)
  if (!e) {
    const err = new Error(`cache entry not found: ${cacheRef}`)
    err.code = 'WEB_CONTENT_NOT_FOUND'
    throw err
  }
  const reader = readerIdentity(ctx)
  authorizeRead(e, reader)
  // Lazy eviction check
  // v2.3.0: ttl === 0 means "no time-based expiry before process exit";
  // only positive values cause an age check.
  if (e.ttlMs > 0 && Date.now() - e.fetchedAt > e.ttlMs) {
    entries.delete(cacheRef)
    const err = new Error(`cache entry expired: ${cacheRef}`)
    err.code = 'WEB_CONTENT_EXPIRED'
    throw err
  }
  // P1 #10: single source of truth — always resolve via PayloadRef.
  let content = null
  if (e.contentRef && e.contentRef.ref) {
    // v2.2.1: inline entries carry their content in the entry itself.
    if (e.contentRef.store === PAYLOAD_REF_INLINE && typeof e.inlineContent === 'string') {
      content = e.inlineContent
    } else {
      content = await loadPayload(ctx, e.contentRef.ref)
    }
  }
  // v2.2.1: the 20 000-char hard cap is enforced by readContent (the single
  // funnel every search_content return passes through), NOT here. The old
  // pre-slice check made any entry > 20 000 chars completely unreadable
  // (WEB_CONTENT_TOO_LARGE before offset/limit could apply) even though
  // source_check writes such entries — search_content could never read back
  // a real source_check cacheRef.
  return { entry: e, content }
}

/**
 * Search a cache entry's content via `readContent` rules (offset / limit
 * / findText / findMode, hard-capped at HARD_CHAR_CAP).
 *
 * @param {any} ctx
 * @param {string} cacheRef
 * @param {{ sourceIndex?: number, offset?: number, limit?: number, findText?: string|string[], findMode?: 'exact'|'case-insensitive'|'fuzzy' }} args
 * @returns {Promise<{ content: string, totalChars: number, matches?: any[] }>}
 */
export async function readEntryContent(ctx, cacheRef, args) {
  const { entry, content } = await get(ctx, cacheRef)
  const text = content || ''
  let sourceText = text
  if (typeof args.sourceIndex === 'number' && args.sourceIndex >= 0 && args.sourceIndex < entry.sources.length) {
    // Per-source content lives in entry.sources[].contentRef (the
    // second-shape case described in SPEC §II.3.4). We honour that by
    // loading the source's own payload.
    const src = entry.sources[args.sourceIndex]
    if (src && src.contentRef && src.contentRef.ref) {
      const sc = await loadPayload(ctx, src.contentRef.ref)
      sourceText = sc || text
    }
  }
  return readContent(sourceText, args)
}

/**
 * @param {any} ctx
 * @returns {{ entries: number, bytes: number, oldestFetchedAt: number, hardCharCap: number }}
 */
export function stats(ctx) {
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
  let bytes = 0
  let oldest = Number.MAX_SAFE_INTEGER
  for (const e of entries.values()) {
    if (e.contentRef && typeof e.contentRef.bytes === 'number') bytes += e.contentRef.bytes
    if (e.fetchedAt < oldest) oldest = e.fetchedAt
  }
  if (!Number.isFinite(oldest)) oldest = 0
  return {
    entries: entries.size,
    bytes,
    oldestFetchedAt: oldest,
    hardCharCap: HARD_CHAR_CAP,
  }
}

/**
 * Delete one cache entry (currently local; storage backend removal is
 * future work).
 */
export function purge(cacheRef) {
  return entries.delete(cacheRef)
}

/**
 * List all cache entries visible to the current reader. Used by
 * `/webcache` command.
 */
export function list(ctx) {
  const reader = readerIdentity(ctx)
  const out = []
  for (const e of entries.values()) {
    try {
      authorizeRead(e, reader)
      out.push({
        cacheRef: e.cacheRef,
        kind: e.kind,
        authenticated: e.authenticated,
        sourceProvider: e.sourceProvider,
        fetchedAt: e.fetchedAt,
        ttlMs: e.ttlMs,
        sourcesCount: e.sources.length,
      })
    } catch {
      // skip; not visible to this reader
    }
  }
  return out
}

function evictIfNeeded(policy) {
  if (!policy) policy = {}
  const maxEntries = Number.isFinite(policy.cacheMaxEntries) && policy.cacheMaxEntries > 0 ? policy.cacheMaxEntries : 128
  const maxBytes = Number.isFinite(policy.cacheMaxBytes) && policy.cacheMaxBytes > 0 ? policy.cacheMaxBytes : 128 * 1024 * 1024
  const sorted = (function () {
    const arr = Array.from(entries.values()).filter((e) => !e.oversized)
    arr.sort((a, b) => a.fetchedAt - b.fetchedAt)
    return arr
  })()
  let bytes = 0
  for (const e of sorted) {
    if (e.contentRef && typeof e.contentRef.bytes === 'number') bytes += e.contentRef.bytes
  }
  while (sorted.length > maxEntries || bytes > maxBytes) {
    const e = sorted.shift()
    if (!e) break
    entries.delete(e.cacheRef)
    if (e.contentRef && typeof e.contentRef.bytes === 'number') bytes -= e.contentRef.bytes
  }
}

export { HARD_CHAR_CAP }
