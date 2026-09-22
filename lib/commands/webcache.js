// lib/commands/webcache.js — /webcache slash command (SPEC §II.10).
//
// Subcommands:
//   list        — show all cache entries visible to the current reader
//   get <ref>   — show one entry (no content)
//   purge <ref> — drop one entry from the local cache
//
// DSH contract (see ./invocation.js for the verified detail):
//   ctx.commands.register({ name, description, handler })  ← `handler`, not `execute`
//   handler(invocation) → { kind: 'success', text } | { kind: 'error', text }
//
// `execute(args)` is the structured core (unit-test surface); `handler`
// tokenizes the typed tail — "/webcache purge wc_abc" arrives as
// " purge wc_abc" — and renders the core's result as text.

import { list, stats, get, purge } from '../cache/index.js'
import { rawArgs, tokens, asSuccess, asError } from './invocation.js'

export const COMMAND_NAME = 'webcache'

const USAGE = 'Usage: /webcache [list | get <cacheRef> | purge <cacheRef>]'

/**
 * @param {{ ctx?: any }} opts
 */
export function createCommand(opts) {
  const ctx = opts && opts.ctx
  const command = {
    name: COMMAND_NAME,
    description: 'List, inspect, or purge DSH Trinity cache entries.',
    input: { hint: '[list | get <cacheRef> | purge <cacheRef>]' },

    /**
     * Structured core.
     *
     * @param {{ subcommand?: string, cacheRef?: string }} [args]
     */
    async execute(args) {
      const a = (args && typeof args === 'object') ? args : {}
      const sub = (typeof a.subcommand === 'string' && a.subcommand.length > 0) ? a.subcommand : 'list'
      if (sub === 'list') {
        return { entries: list(ctx), stats: stats(ctx) }
      }
      if (sub === 'get' || sub === 'purge') {
        if (typeof a.cacheRef !== 'string' || a.cacheRef.length === 0) {
          return { ok: false, code: 'MISSING_REF', message: `cacheRef is required\n${USAGE}` }
        }
      }
      if (sub === 'get') {
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
      if (sub === 'purge') {
        return { ok: purge(a.cacheRef), cacheRef: a.cacheRef }
      }
      return { ok: false, code: 'UNKNOWN_SUBCOMMAND', message: `unknown subcommand: ${sub}\n${USAGE}` }
    },

    /**
     * DSH entry point.
     *
     * @param {{ rawInput?: string }} invocation
     */
    async handler(invocation) {
      const t = tokens(rawArgs(invocation))
      const result = await command.execute({ subcommand: t[0], cacheRef: t[1] })
      return renderResult(result)
    },
  }
  return command
}

/**
 * @param {any} result
 * @returns {{ kind: 'success', text?: string } | { kind: 'error', text: string }}
 */
function renderResult(result) {
  if (!result || typeof result !== 'object') return asError('webcache: empty result')

  if (Array.isArray(result.entries)) {
    const s = result.stats || {}
    const lines = [
      `Cache: ${s.entries ?? result.entries.length} entries / ${s.bytes ?? 0} bytes / hardCharCap=${s.hardCharCap ?? '?'}`,
    ]
    if (result.entries.length === 0) {
      lines.push('', 'No entries are visible to this reader.')
    } else {
      lines.push('')
      for (const e of result.entries) lines.push(`  ${describeRow(e)}`)
      lines.push('', 'Inspect one with /webcache get <cacheRef>; drop one with /webcache purge <cacheRef>.')
    }
    return asSuccess(lines.join('\n'))
  }

  if (result.entry && typeof result.entry === 'object') {
    const e = result.entry
    return asSuccess([
      `cacheRef: ${e.cacheRef}`,
      `kind: ${e.kind}`,
      `provider: ${e.sourceProvider || '-'}`,
      `sources: ${e.sourcesCount}`,
      `authenticated: ${e.authenticated ? 'yes' : 'no'}`,
      `fetchedAt: ${isoOrUnknown(e.fetchedAt)}`,
      `ttlMs: ${e.ttlMs}`,
      `contentLength: ${result.contentLength ?? 0} chars`,
    ].join('\n'))
  }

  if (result.ok === true && typeof result.cacheRef === 'string') {
    return asSuccess(`purged ${result.cacheRef}`)
  }
  if (result.ok === false) {
    if (typeof result.message === 'string' && result.message.length > 0) return asError(result.message)
    return asError(`no such cache entry: ${result.cacheRef || '(unknown)'}`)
  }
  return asSuccess(JSON.stringify(result))
}

/**
 * @param {any} e
 * @returns {string}
 */
function describeRow(e) {
  const ttl = typeof e.ttlMs === 'number' ? `${Math.round(e.ttlMs / 1000)}s` : '?'
  return [
    e.cacheRef,
    e.kind,
    `provider=${e.sourceProvider || '-'}`,
    `sources=${e.sourcesCount}`,
    `auth=${e.authenticated ? 'yes' : 'no'}`,
    `ttl=${ttl}`,
    `fetched=${isoOrUnknown(e.fetchedAt)}`,
  ].join('  ')
}

/**
 * @param {any} value
 * @returns {string}
 */
function isoOrUnknown(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : 'unknown'
}
