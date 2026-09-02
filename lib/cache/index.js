// lib/cache/index.js — single CacheModule façade used by Tools.
//
// In-memory process-local cache. Persistence is delegated to ctx.storage
// for inline payloads; when no storage seam is available the content is
// kept inside the entry itself (inline fallback, v2.2.1).
// Eviction is lazy on read/write: oldest entries go first.

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
 * Settle an entry into the cache. Returns the assigned cacheRef.
 *
 * P1 #10: SPEC §II.3.4 mandates the PayloadRef discriminated union as
 * the single source of truth for content. We no longer keep a parallel
 * `_content` field — the entry holds `contentRef` and `get()` always
 * resolves through `loadPayload(ctx, cacheRef)`.
 *
 * @param {any} ctx
 * @param {{
 *   kind: 'search' | 'fetch' | 'page' | 'pdf' | 'video',
 *   authenticated?: boolean,
 *   sourceProvider?: string,
 *   sources: any[],
 *   inlineContent?: string,
 *   ttlMs?: number,
 * }} input
 * @returns {Promise<{ cacheRef: string, entry: CacheEntry }>}
 */
export async function put(ctx, input) {
  const writer = readerIdentity(ctx)
  const cacheRef = makeCacheRef()
  const ttlMs = input.ttlMs || 3600000
  const scope = scopeFor(writer, { authenticated: !!input.authenticated })
  let contentRef = null
  if (typeof input.inlineContent === 'string' && input.inlineContent.length > 0) {
    contentRef = await savePayload(ctx, cacheRef, input.inlineContent, { kind: input.kind, owner: ctx })
  }
  const entry = {
    cacheRef,
    kind: input.kind,
    visibilityScope: scope,
    authenticated: !!input.authenticated,
    sourceProvider: input.sourceProvider,
    sources: input.sources,
    fetchedAt: Date.now(),
    ttlMs,
    contentRef: contentRef || undefined,
  }
  // v2.2.1: inline fallback — keep the content inside the entry so
  // search_content can always read it back, even without a storage seam.
  if (contentRef && contentRef.store === PAYLOAD_REF_INLINE && typeof input.inlineContent === 'string') {
    entry.inlineContent = input.inlineContent
  }
  entries.set(cacheRef, entry)
  evictIfNeeded()
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
  if (Date.now() - e.fetchedAt > e.ttlMs) {
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

function evictIfNeeded() {
  const MAX_ENTRIES = 128
  if (entries.size <= MAX_ENTRIES) return
  // Oldest-first eviction.
  const sorted = Array.from(entries.values()).sort((a, b) => a.fetchedAt - b.fetchedAt)
  while (entries.size > MAX_ENTRIES) {
    const e = sorted.shift()
    if (!e) break
    entries.delete(e.cacheRef)
  }
}

export { HARD_CHAR_CAP }
