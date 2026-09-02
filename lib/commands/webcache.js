// lib/commands/webcache.js — /webcache slash command (SPEC §II.10).
//
// Subcommands:
//   list        — show all cache entries visible to the current reader
//   get <ref>   — show one entry (no content)
//   purge <ref> — drop one entry from the local cache

import { list, stats, get, purge } from '../cache/index.js'

export const COMMAND_NAME = 'webcache'

/**
 * @param {{ ctx?: any }} opts
 */
export function createCommand(opts) {
  const ctx = opts && opts.ctx
  return {
    name: COMMAND_NAME,
    description: 'List, inspect, or purge DSH Trinity cache entries.',
    async execute(args) {
      const a = (args && typeof args === 'object') ? args : {}
      const sub = (typeof a.subcommand === 'string' && a.subcommand.length > 0) ? a.subcommand : 'list'
      if (sub === 'list') {
        return { entries: list(ctx), stats: stats(ctx) }
      }
      if (sub === 'get' && typeof a.cacheRef === 'string') {
        try {
          const { entry, content } = await get(ctx, a.cacheRef)
          return {
            entry: {
              cacheRef: entry.cacheRef,
              kind: entry.kind,
              sourceProvider: entry.sourceProvider,
              sourcesCount: entry.sources.length,
              authenticated: entry.authenticated,
              fetchedAt: entry.fetchedAt,
              ttlMs: entry.ttlMs,
            },
            contentLength: typeof content === 'string' ? content.length : 0,
          }
        } catch (e) {
          return { ok: false, code: e && e.code, message: e && e.message }
        }
      }
      if (sub === 'purge' && typeof a.cacheRef === 'string') {
        return { ok: purge(a.cacheRef), cacheRef: a.cacheRef }
      }
      return { ok: false, message: `unknown subcommand: ${sub}` }
    },
  }
}
