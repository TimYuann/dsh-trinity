// lib/commands/webdoctor-keys.js — /webdoctor-keys slash command (v2.2).
//
// Manage provider API keys through DSH's encrypted credential store
// (ctx.credentials). The DSH credentials seam contract (verified against
// @deepseek-ai/dsh-credentials + dsh-credentials-local):
//
//   credentials.resolve(ref)   → Promise<{ value, source } | undefined>
//   credentials.describe(ref)  → Promise<{ configured, source?, writable }>
//   credentials.set(ref, value)→ Promise<void>   (durable store)
//   credentials.unset(ref)     → Promise<void>
//
// `ref` is a plain POSIX identifier — an environment-variable NAME
// (`EXA_API_KEY`). v2.2 replaces the v2.1 `{ key: 'webAccessChain_exa_1' }`
// object-argument calls (which never matched the seam and silently failed).
//
// Command surface (parse from `args`):
//   /webdoctor-keys list                   — show every provider slot + state
//   /webdoctor-keys status                 — onboarding: what's missing and
//                                            the exact command to fix it
//   /webdoctor-keys set <provider> <key>   — write to DSH credentials
//   /webdoctor-keys clear <provider>       — drop from DSH credentials
//   /webdoctor-keys test <provider>        — describe + report presence/source
//   /webdoctor-keys help                   — usage
//
// The DSH slash-command layer invokes commands with the parsed argument
// object in `args`; subcommand shape is `{ subcommand, provider, key }`
// (mirroring `lib/commands/webcache.js` which already uses `subcommand`).
// We additionally tolerate a free-form `raw` string + positionals for
// robust shell splitting (hand-rolled to avoid an extra dependency).

import { ALL_PROVIDER_IDS } from '../config-schema.js'
import { providerIdToEnvName, providerCredentialRef } from '../credentials/resolve.js'

export const COMMAND_NAME = 'webdoctor-keys'

/** Known shell parse of placeholders that should be rejected as empty. */
const PLACEHOLDER_TOKENS = new Set([
  'your-key', 'xxx', 'dummy', 'null', 'undefined', 'changeme',
  'placeholder', 'todo', 'fixme', 'replace-me', 'replace_me',
  'example', 'sample', 'test',
])

/** Slots probed in list/status (slot 1 + rotation slots 2-3). */
const LIST_SLOTS = [1, 2, 3]

const HELP_TEXT = [
  'Usage: /webdoctor-keys <subcommand> [args]',
  '',
  'Subcommands:',
  '  list                          Show every provider slot with state.',
  '  status                        Onboarding view: which keys are missing',
  '                                and the exact commands to add them.',
  '  set <provider> <key>          Store the API key in DSH\'s credential store.',
  '  clear <provider>              Remove the stored credential.',
  '  test <provider>               Report whether the stored credential resolves.',
  '  help                          Print this message.',
  '',
  'Providers: ' + ALL_PROVIDER_IDS.join(', '),
  '',
  'Key storage: DSH credential store (~/.dsh/.credentials.yaml), refs are',
  'env-var names (e.g. EXA_API_KEY). Resolution order: process env → store',
  '→ DSH .env files. You can also set $<PROVIDER>_API_KEY in your DSH',
  'launch environment instead of using this command.',
  '',
  'Examples:',
  '  /webdoctor-keys status',
  '  /webdoctor-keys set exa sk-live-...',
  '  /webdoctor-keys clear brave',
  '  /webdoctor-keys test tavily',
].join('\n')

/**
 * @param {{ ctx?: any }} [opts]
 */
export function createCommand(opts = {}) {
  const ctx = opts && opts.ctx
  return {
    name: COMMAND_NAME,
    description: 'Manage DSH Trinity provider API keys (status/list/set/clear/test/help).',
    async execute(args) {
      const parsed = parseArgs(args)
      const sub = parsed.subcommand
      if (!sub || sub === 'help') return { ok: true, message: HELP_TEXT }
      if (!ctx || typeof ctx.get !== 'function') {
        return { ok: false, code: 'NO_CTX', message: 'cordis ctx unavailable' }
      }
      const credentials = ctx.get('credentials')
      if (!credentials) {
        return { ok: false, code: 'NO_CREDENTIALS', message: 'credentials service unavailable' }
      }
      switch (sub) {
        case 'list':
          return await runList(credentials)
        case 'status':
          return await runStatus(credentials)
        case 'set': {
          const provider = parsed.provider
          const value = parsed.key
          const v = validateSet(provider, value)
          if (v.error) return { ok: false, code: v.code, message: v.error }
          return await runSet(credentials, provider, value)
        }
        case 'clear': {
          const provider = parsed.provider
          const v = requireProvider(provider)
          if (v.error) return { ok: false, code: v.code, message: v.error }
          return await runClear(credentials, provider)
        }
        case 'test': {
          const provider = parsed.provider
          const v = requireProvider(provider)
          if (v.error) return { ok: false, code: v.code, message: v.error }
          return await runTest(credentials, provider)
        }
        default:
          return { ok: false, code: 'UNKNOWN_SUBCOMMAND', message: `unknown subcommand: ${sub}\n${HELP_TEXT}` }
      }
    },
  }
}

function parseArgs(args) {
  const out = { subcommand: undefined, provider: undefined, key: undefined, raw: undefined }
  if (args == null) return out
  if (typeof args === 'string') {
    out.raw = args
    const toks = args.trim().split(/\s+/).filter((t) => t.length > 0)
    out.subcommand = toks[0]
    out.provider = toks[1]
    out.key = toks.slice(2).join(' ')
    return out
  }
  if (typeof args !== 'object') return out
  // 1) Structured shape from the slash-command layer:
  if (typeof args.subcommand === 'string') out.subcommand = args.subcommand
  if (typeof args.provider === 'string') out.provider = args.provider
  if (typeof args.key === 'string') out.key = args.key
  // 2) Fallback: a free-form `raw` / `input` field carrying the typed tail.
  const raw = typeof args.raw === 'string' ? args.raw
            : typeof args.input === 'string' ? args.input
            : typeof args.rest === 'string' ? args.rest
            : null
  if (raw && !out.subcommand) {
    const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0)
    out.subcommand = toks[0]
    out.provider = toks[1]
    out.key = toks.slice(2).join(' ')
    out.raw = raw
  }
  return out
}

function validateSet(provider, value) {
  const pv = requireProvider(provider)
  if (pv.error) return pv
  if (typeof value !== 'string' || value.length === 0) {
    return { error: 'key is required', code: 'EMPTY_KEY' }
  }
  const lower = value.trim().toLowerCase()
  if (PLACEHOLDER_TOKENS.has(lower)) {
    return { error: `refusing placeholder key (${value})`, code: 'PLACEHOLDER_KEY' }
  }
  return { ok: true }
}

function requireProvider(provider) {
  if (typeof provider !== 'string' || provider.length === 0) {
    return { error: 'provider is required', code: 'MISSING_PROVIDER' }
  }
  if (!ALL_PROVIDER_IDS.includes(provider)) {
    return { error: `unknown provider: ${provider} (expected one of: ${ALL_PROVIDER_IDS.join(', ')})`, code: 'UNKNOWN_PROVIDER' }
  }
  return { ok: true }
}

/**
 * Read the presence facts for one credential ref through the real seam.
 *
 * @param {any} credentials
 * @param {string} ref  env-name ref, e.g. 'EXA_API_KEY'
 * @returns {Promise<{ presence: string, source: string | null, last4: string | null, writable: boolean | null }>}
 */
async function describeRef(credentials, ref) {
  const out = { presence: 'UNSET', source: null, last4: null, writable: null }
  try {
    if (typeof credentials.describe === 'function') {
      const info = await credentials.describe(ref)
      if (info && typeof info === 'object') {
        out.presence = info.configured ? 'SET' : 'UNSET'
        out.source = typeof info.source === 'string' ? info.source : null
        out.writable = typeof info.writable === 'boolean' ? info.writable : null
      }
    }
  } catch {
    // ignore — describe not implemented in this credentials backend
  }
  // Optional last-4 fingerprint — only shown when resolve() returns a
  // value. Avoids echoing the full key.
  if (out.presence === 'SET' && typeof credentials.resolve === 'function') {
    try {
      const r = await credentials.resolve(ref)
      if (r && typeof r.value === 'string' && r.value.length >= 4) {
        out.last4 = r.value.slice(-4)
        if (!out.source && typeof r.source === 'string') out.source = r.source
      }
    } catch {
      out.last4 = null
    }
  }
  return out
}

async function runList(credentials) {
  const rows = []
  for (const provider of ALL_PROVIDER_IDS) {
    for (const slot of LIST_SLOTS) {
      const ref = providerCredentialRef(provider, slot)
      const info = await describeRef(credentials, ref)
      rows.push({ provider, slot, ref, presence: info.presence, source: info.source, last4: info.last4 })
    }
  }
  return { ok: true, rows }
}

/**
 * Onboarding view (the "do you have these keys?" command). Summarises
 * configured vs missing providers and gives the exact command to fix
 * each gap.
 */
async function runStatus(credentials) {
  const missing = []
  const configured = []
  for (const provider of ALL_PROVIDER_IDS) {
    const ref = providerCredentialRef(provider, 1)
    const info = await describeRef(credentials, ref)
    const envName = providerIdToEnvName(provider)
    if (info.presence === 'SET') {
      configured.push({ provider, ref, source: info.source || null, writable: info.writable })
    } else {
      missing.push({ provider, ref, envName })
    }
  }
  const hint = []
  if (missing.length === 0) {
    hint.push('All providers have a slot-1 key configured. To use one in a search, pin it with web_search_ex(routing=\'<provider>\') or rely on the auto chain.')
  } else {
    hint.push(`Missing keys (${missing.length} providers). Add the ones you have, for example:`)
    for (const m of missing.slice(0, 6)) {
      hint.push(`  /webdoctor-keys set ${m.provider} <your-key>`)
    }
    if (missing.length > 6) hint.push(`  … and ${missing.length - 6} more (see /webdoctor-keys list)`)
    hint.push('Alternative: export $<PROVIDER>_API_KEY in the DSH launch environment (resolution: process env → credential store → DSH .env files).')
  }
  return {
    ok: true,
    summary: `providers: ${ALL_PROVIDER_IDS.length} total, ${configured.length} with a configured key, ${missing.length} missing`,
    configured,
    missing,
    hint: hint.join('\n'),
  }
}

async function runSet(credentials, provider, value) {
  const ref = providerCredentialRef(provider, 1)
  try {
    // v2.2: the seam's set(ref, value) takes the env-name string directly.
    await credentials.set(ref, value)
    let last4 = null
    try {
      const r = await credentials.resolve(ref)
      if (r && typeof r.value === 'string' && r.value.length >= 4) last4 = r.value.slice(-4)
    } catch {}
    return {
      ok: true,
      provider,
      ref,
      message: `✓ ${provider} key set under credential ref ${ref}${last4 ? ` (last-4: ${last4})` : ''}`,
    }
  } catch (e) {
    return { ok: false, code: e && e.code ? e.code : 'SET_FAILED', message: `set failed: ${e && e.message ? e.message : e}` }
  }
}

async function runClear(credentials, provider) {
  const ref = providerCredentialRef(provider, 1)
  try {
    if (typeof credentials.unset === 'function') {
      await credentials.unset(ref)
    } else {
      return { ok: false, code: 'NO_UNSET', message: 'credentials service has no unset()' }
    }
    return { ok: true, provider, ref, message: `✓ ${provider} key cleared (credential ref ${ref})` }
  } catch (e) {
    return { ok: false, code: e && e.code ? e.code : 'CLEAR_FAILED', message: `clear failed: ${e && e.message ? e.message : e}` }
  }
}

async function runTest(credentials, provider) {
  const ref = providerCredentialRef(provider, 1)
  const envName = providerIdToEnvName(provider)
  const info = await describeRef(credentials, ref)
  return {
    ok: true,
    provider,
    ref,
    envName,
    presence: info.presence,
    source: info.source,
    writable: info.writable,
    last4: info.last4,
  }
}
