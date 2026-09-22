// lib/commands/invocation.js — shared adapter for DSH's slash-command contract.
//
// DSH registers slash commands through `ctx.commands.register(definition)` and
// invokes them as `definition.handler(invocation)`. Both halves of that
// contract were verified against the published packages
// `@deepseek-ai/dsh-commands@0.1.5-rc.2` (the host this bundle was first wired
// for) and `@0.1.6-alpha.1`; the two versions agree on every point below:
//
//   1. `normalizeDefinition()` REQUIRES a function `handler`:
//        if (typeof definition.handler !== "function")
//          throw new TypeError(`command "${name}" handler must be a function`)
//      A definition carrying only `execute` is rejected at registration time —
//      which is exactly how v2.3.0-rc.2 lost /webdoctor, /webcache and
//      /webdoctor-keys (three `web-access-chain.apply { phase: 'commands.*' }`
//      warnings on every boot, no commands).
//
//   2. `normalizeResult()` requires a discriminated result:
//        { kind: 'success', text?: string } | { kind: 'error', text: string }
//      The error text must be a non-empty (non-whitespace) string.
//
//   3. `invocation` is frozen and carries
//        { commandId, agent, rawInput, attachments, signal }
//      where `rawInput` is the EXACT text after the command name INCLUDING the
//      separator whitespace: "/webcache purge abc" → " purge abc". Every parser
//      in this directory therefore trims before tokenizing.
//
//   4. `recordInput: false` on a definition keeps `rawInput` out of the durable
//      `command/run` session event (the handler still receives it) — used by
//      /webdoctor-keys, whose tail carries a credential value.
//
// The command cores in this directory keep returning their structured objects
// (machine-readable and driven directly by the unit tests); each `handler` is a
// thin adapter that parses the typed tail, calls the core, and renders the
// result through `asSuccess` / `asError` below.

/**
 * The typed tail of one invocation, trimmed. Tolerates a bare string and the
 * legacy `{ raw | input | rest }` shapes so the cores stay directly testable.
 *
 * @param {any} invocation
 * @returns {string}
 */
export function rawArgs(invocation) {
  if (typeof invocation === 'string') return invocation.trim()
  if (!invocation || typeof invocation !== 'object') return ''
  const raw = invocation.rawInput ?? invocation.raw ?? invocation.input ?? invocation.rest
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Whitespace tokens of a typed tail. No shell quoting: provider ids, cacheRefs
 * and flags never contain spaces, and `/webdoctor-keys set <p> <key>` keeps the
 * remainder as the key (see `rest`).
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function tokens(raw) {
  return String(raw == null ? '' : raw).trim().split(/\s+/).filter((t) => t.length > 0)
}

/**
 * Everything after the first `n` tokens, joined by a single space.
 *
 * @param {string} raw
 * @param {number} n
 * @returns {string}
 */
export function rest(raw, n) {
  return tokens(raw).slice(n).join(' ')
}

/**
 * Whether any token is one of `names`, with or without a leading dash.
 *
 * @param {string} raw
 * @param {...string} names
 * @returns {boolean}
 */
export function hasFlag(raw, ...names) {
  const wanted = new Set(names.map((n) => String(n).replace(/^--?/, '').toLowerCase()))
  return tokens(raw).some((t) => wanted.has(t.replace(/^--?/, '').toLowerCase()))
}

/**
 * A successful CommandResult.
 *
 * @param {string} [text]
 * @returns {{ kind: 'success', text?: string }}
 */
export function asSuccess(text) {
  return typeof text === 'string' && text.length > 0 ? { kind: 'success', text } : { kind: 'success' }
}

/**
 * A failed CommandResult. DSH rejects an empty error text, so a blank input
 * degrades to the caller-supplied fallback instead of throwing inside the
 * result normalizer.
 *
 * @param {any} text
 * @param {string} [fallback]
 * @returns {{ kind: 'error', text: string }}
 */
export function asError(text, fallback = 'command failed') {
  const s = typeof text === 'string' ? text.trim() : (text == null ? '' : String(text).trim())
  return { kind: 'error', text: s.length > 0 ? s : fallback }
}
