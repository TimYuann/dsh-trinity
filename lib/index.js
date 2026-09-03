// lib/index.js — DSH Trinity v2.2.3 entry point.
//
// Wires the namespaced search/fetch providers (SPEC §II.9), registers the
// web-access-chain settings namespace, installs the credential pool runner,
// exposes the system-prompt section + Tool surface per SPEC §I.5/§I.7,
// and registers the slash commands /webdoctor, /webcache, /webdoctor-keys.
//
// v2.2 changes (see README "v2.2 release notes"):
//   - Credential refs migrated to DSH-native env-name refs
//     (EXA_API_KEY / GEMINI_API_KEY / …) with real ctx.credentials calls.
//   - Settings namespace renamed 'webAccessChain' → 'web-access-chain'.
//   - Fixed undeclared-service accesses (ctx.llm / ctx.session /
//     ctx.agentDefaultModel) that crashed every tool in the live host.
//   - Skills now register against the real SkillRegistration contract.
//   - /webdoctor-keys rewritten against the credentials seam + new
//     `status` onboarding subcommand.
//
// v2.2.1 changes (live-host E2E fix round):
//   - defineTool shim no longer compiles free-form object nodes into empty
//     strict shells (web_doctor activeProbe lastPing was rejected by the
//     host validator as undeclared properties).
//   - Cache inline fallback now round-trips: entries carry the content
//     when no storage seam exists (search_content no longer returns empty).
//   - web_search_ex dropped the fake cacheRef claim (the chain never wrote
//     cache; source_check is the only cacheRef producer).
//
// v2.2.3 changes (Web UI Provider Key Settings):
//   - Adds a browser-side `lib/client.js` that registers a
//     `settings.section` slot in the DSH Web UI Settings panel. The
//     card reads / writes keys through DSH's existing
//     `ctx.remote.credentials.{describe,set,unset}` namespace — the
//     same wire that the slash command (`/webdoctor-keys`) uses — so
//     no new host-side surface, no custom Remote namespace, no
//     settings YAML entry, no private HTTP endpoint, and no host log
//     can echo a key.
//   - Adds `dsh.client.platform: "web"` and `exports["./client"]` to
//     package.json so the client-modules node half picks the bundle
//     up at boot. The bundle is hand-rolled (no tsdown) so it stays
//     single-file and auditable.
//   - `last4` is computed in the BROWSER from the value the user
//     typed the instant they clicked Save, and lives only in
//     component state. It is dropped on next mount, page reload, or
//     context stop. The host never sees the value past the `set`
//     call; the credential seam itself projects the full key into
//     `last4` only on the host side of `remote.credentials.describe`
//     (which returns `configured` / `source` / `writable`, no value,
//     no last4).

import { createLogger } from './logger.js'
import { registerSettings, readSettings, patchSetting } from './settings/register.js'
import { chainedSearch, isChainedSearchAvailable, getPoolState, getLastError } from './providers/search/chained.js'
import { chainedFetch } from './providers/fetch/chained-fetch.js'
import { wrapProviderError } from './errors.js'
import { redactAllCredentials } from './key-redact.js'
import { TOOL_GUIDANCE } from './tool-guidance.js'

import { createTool as createWebSearchEx } from './tools/web-search-ex.js'
import { createTool as createSearchContent } from './tools/search-content.js'
import { createTool as createSourceCheck } from './tools/source-check.js'
import { createTool as createWebDoctor } from './tools/web-doctor.js'
import { createTool as createGithubPrIssue } from './tools/github-pr-issue.js'
import { createTool as createVideoExtract } from './tools/video-extract.js'
import { createTool as createPdfExtract } from './tools/pdf-extract.js'
import { registerWebAccessSkill } from './skills/web-access.js'
import { registerWebAccessDoctorSkill } from './skills/web-access-doctor.js'
import { createCommand as createWebDoctorCmd } from './commands/webdoctor.js'
import { createCommand as createWebCacheCmd } from './commands/webcache.js'
import { createCommand as createWebDoctorKeysCmd } from './commands/webdoctor-keys.js'
import { createProbe } from './doctor/probe.js'
import { registerIfEnabled as registerToolIfEnabled } from './util/gated-register.js'

export const name = 'web-access-chain'
export const version = '2.2.3'

// Hard deps: web seam + tools + systemPrompt + settings + credentials +
// agents. Skills + commands + storage + spillStore are optional — the
// plugin degrades gracefully when they're missing.
export const inject = ['web', 'tools', 'systemPrompt', 'settings', 'credentials', 'agents']

/**
 * Run a registration inside `ctx.effect(...)` and warn on failure. The
 * disposer returned by the registration (when present) becomes the
 * effect's disposer, so `cordis_stop` / `cordis_undefine` undo it
 * (P0 #2 / P0 #3 / P3 #22).
 */
function safeRegister(ctx, logger, label, fn) {
  try {
    return ctx.effect(fn)
  } catch (e) {
    logger.warn('web-access-chain.apply', { phase: label }, (e && e.message ? e.message : e))
    return () => {}
  }
}

/**
 * @param {any} ctx
 * @param {any} config
 */
export async function apply(ctx, config) {
  const logger = createLogger(ctx, { keys: [] })

  const web = typeof ctx.get === 'function' ? ctx.get('web') : null
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  if (!web || !tools) {
    logger.warn('web-access-chain.apply', { phase: 'init' }, 'web/tools services unavailable — skipping registration')
    return
  }

  // ── 1. Register settings namespace (SPEC §II.3.2 Contract B) ────
  // P0 #3: bind the namespace registration to a fiber effect so
  // cordis_stop / cordis_undefine undo the registration. The whole call
  // is wrapped (not just the disposer) so a seam-side throw cannot crash
  // apply().
  let settingsHandle = null
  try {
    settingsHandle = registerSettings(ctx)
  } catch (e) {
    logger.warn('web-access-chain.apply', { phase: 'settings' }, e && e.message ? e.message : e)
  }
  if (settingsHandle && typeof settingsHandle.disposer === 'function') {
    safeRegister(ctx, logger, 'settings', () => settingsHandle.disposer)
  }

  // ── 2. Build the chain ctx ──────────────────────────────────────
  // (legacy-import was removed in v2.1 — see SPEC v2.1 release notes.)
  const settings = readSettings(ctx)
  const chainedCtx = buildChainedCtx(ctx, settings)

  // P0 #12: boot assertion — the web seam's CONFIGURED provider ids must
  // include the ones cordis.patch.yml pins (web_search / web_fetch route
  // through them). NOTE: `web.searchProvider` is not a property of the
  // WebRuntime seam; the configured ids live on `searchProviderId` /
  // `fetchProviderId` (v2.2 fix — the old check always warned).
  if (!web || !web.searchProviderId || !web.fetchProviderId) {
    logger.warn('web-access-chain.apply',
      { phase: 'tool-surface-incomplete' },
      'web.searchProviderId or web.fetchProviderId unset — cordis.patch.yml pinning did not apply; the web seam will auto-select when exactly one provider is usable')
  }

  // ── 4. System-prompt section (SPEC §I.7) ───────────────────────
  // P0 #4: single source of truth — lib/tool-guidance.js.
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    safeRegister(ctx, logger, 'systemPrompt', () => systemPrompt.section({
      name: 'dsh-web-search-chained:tool-guidance',
      order: 100,
      text: TOOL_GUIDANCE,
    }))
  }

  // ── 5. Register search provider ────────────────────────────────
  safeRegister(ctx, logger, 'search-provider', () => web.registerSearchProvider({
    id: 'web-access-chain-search',
    available() {
      // SPEC §II.2: ALWAYS return true. The chain itself decides whether
      // any route is usable and returns WEB_SEARCH_CHAIN_EXHAUSTED.
      return true
    },
    async search(request, signal) {
      try {
        const result = await chainedSearch(request || { query: '' }, signal, chainedCtx)
        return result
      } catch (e) {
        loggerWithKeys(logger, chainedCtx.keysForRedaction).error('chained.search', e, { phase: 'fail' })
        throw e
      }
    },
  }))

  // ── 6. Register fetch provider ────────────────────────────────
  safeRegister(ctx, logger, 'fetch-provider', () => web.registerFetchProvider({
    id: 'web-access-chain-fetch',
    // SPEC §II.2: available() ALWAYS returns true. The chain itself
    // decides whether the runtime can satisfy the request and returns a
    // structured failure when it cannot (NO_FETCH_RUNTIME).
    available() {
      return true
    },
    async fetch(request, signal) {
      try {
        const result = await chainedFetch(request, signal, {
          ssrf: (settings && settings.ssrf) || { allowRanges: [], trustEnvProxy: false },
          domainPolicy: (settings && settings.domainPolicy) || { allow: [], deny: [] },
          maxBytes: ((settings && settings.fetchMaxResponseMB) || 5) * 1024 * 1024,
          settings,
          ctx,
        })
        return result
      } catch (e) {
        loggerWithKeys(logger, chainedCtx.keysForRedaction).error('chained-fetch.fetch', e, { phase: 'fail' })
        throw e
      }
    },
  }))

  // ── 7. Register the slim default Tool surface (SPEC §I.5) ───────
  const toolsCtx = { ctx, settings, chainedCtx, web, probe: createProbe(ctx, settings) }
  safeRegister(ctx, logger, 'tools.web_search_ex', () => tools.register(createWebSearchEx(toolsCtx)))
  safeRegister(ctx, logger, 'tools.search_content', () => tools.register(createSearchContent(toolsCtx)))
  safeRegister(ctx, logger, 'tools.source_check', () => tools.register(createSourceCheck(toolsCtx)))
  safeRegister(ctx, logger, 'tools.web_doctor', () => tools.register(createWebDoctor(toolsCtx)))
  // Gated specialised Tools (SPEC §II.5 / acceptance #14). Each is
  // registration-gated by its own settings.tools.*.enabled flag.
  // R3 P0 #6: registerIfEnabled subscribes to settings.on('change') so
  // operators can flip a gate at runtime (no profile reload).
  registerToolIfEnabled({
    ctx,
    settings,
    settingsKey: (s) => !!(s && s.tools && s.tools.githubPrIssue && s.tools.githubPrIssue.enabled === true),
    create: () => createGithubPrIssue(toolsCtx),
    register: (t) => tools.register(t),
    label: 'tools.github_pr_issue',
    safeRegister: (fn) => safeRegister(ctx, logger, 'tools.github_pr_issue', fn),
  })
  registerToolIfEnabled({
    ctx,
    settings,
    settingsKey: (s) => !!(s && s.tools && s.tools.videoExtract && s.tools.videoExtract.enabled === true),
    create: () => createVideoExtract(toolsCtx),
    register: (t) => tools.register(t),
    label: 'tools.video_extract',
    safeRegister: (fn) => safeRegister(ctx, logger, 'tools.video_extract', fn),
  })
  registerToolIfEnabled({
    ctx,
    settings,
    settingsKey: (s) => !!(s && s.tools && s.tools.pdfExtract && s.tools.pdfExtract.enabled === true),
    create: () => createPdfExtract(toolsCtx),
    register: (t) => tools.register(t),
    label: 'tools.pdf_extract',
    safeRegister: (fn) => safeRegister(ctx, logger, 'tools.pdf_extract', fn),
  })

  // ── 8. Skills (SPEC §I.6) ──────────────────────────────────────
  // P0 #2: wrap in ctx.effect so the registration's disposer reaches the
  // Cordis fiber (cordis_stop must undo every registration).
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : null
  if (skills && typeof skills.register === 'function') {
    safeRegister(ctx, logger, 'skills.web-access', () => registerWebAccessSkill(ctx, skills))
    safeRegister(ctx, logger, 'skills.web-access-doctor', () => registerWebAccessDoctorSkill(ctx, skills))
  }

  // ── 9. Commands (SPEC §II.10) ──────────────────────────────────
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : null
  if (commands && typeof commands.register === 'function') {
    safeRegister(ctx, logger, 'commands.webdoctor', () => commands.register(createWebDoctorCmd(toolsCtx)))
    safeRegister(ctx, logger, 'commands.webcache', () => commands.register(createWebCacheCmd(toolsCtx)))
    safeRegister(ctx, logger, 'commands.webdoctor-keys', () => commands.register(createWebDoctorKeysCmd(toolsCtx)))
  }

  // ── 10. Done ────────────────────────────────────────────────────
  logger.info('web-access-chain.init', {
    phase: 'done',
    settings: settings ? Object.keys(settings).length : 0,
  })
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function buildChainedCtx(ctx, settings) {
  return {
    ctx,
    settings,
    rawConfig: settings || {},
    config: settings || {},
    resolved: {},
    keysForRedaction: [],
  }
}

function loggerWithKeys(base, keys) {
  if (!base) return null
  return {
    debug: (msg, m) => base.debug(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    info: (msg, m) => base.info(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    warn: (msg, e, m) => base.warn(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, e, m),
    error: (msg, e, m) => base.error(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, e, m),
  }
}
