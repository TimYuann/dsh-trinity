// lib/index.js — DSH Trinity v2.3.0 entry point.
//
// Wires the namespaced search/fetch providers (SPEC §II.9), the live
// SettingsScope watcher, the credential pool runner, the system-prompt
// section + Tool surface per SPEC §I.5/§I.7, and the slash commands
// /webdoctor, /webcache, /webdoctor-keys.
//
// v2.3.0 contract closure (see BASELINE_v2.3.0.md /
// docs/dsh-trinity-v2.3-reviewed-development-plan.md § Commit 2):
//
//   - `registerSettings` returns the real `SettingsScope` (no
//     fabricated `disposer` wrapper).
//   - `apply()` owns one mutable runtime ref (`runtimeSettings`) that
//     the live watcher mutates on every `scope.watch` event. Every
//     consumer reads `.get()`; no consumer caches the initial value.
//   - `chainedCtx` is built once against a live Proxy so
//     `chainedCtx.config.<key>` reflects the current settings on
//     every read.
//   - Gated tools reconcile bidirectionally:
//       false→true → register once
//       true→true  → none
//       true→false → dispose once
//       false→false → none
//   - Adapter gates in settings.adapters.* are honoured by
//     `matchSpecializedAdapter` and the content-type dispatch in
//     `chainedFetch`.
//   - Native providers' `available()` ALWAYS returns true so the
//     host's web seam auto-selection does not flicker; the chain
//     itself returns structured failure on a missing-route request.
//
// The previous (v2.2.x) per-call fallback to v1 `searchProviderOrder`
// is gone; the only routing surface now is the Tool `routing` arg
// and the live `settings.routing`.

import { createLogger } from './logger.js'
import { registerSettings, readSettings, patchSetting, createRuntimeSettings } from './settings/register.js'
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
export const version = '2.3.0-rc.0'

export const inject = ['web', 'tools', 'systemPrompt', 'settings', 'credentials', 'agents']

function safeRegister(ctx, logger, label, fn) {
  try {
    return ctx.effect(fn)
  } catch (e) {
    const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : '')
    logger.warn('web-access-chain.apply', { phase: label }, msg)
    return () => {}
  }
}

/**
 * Build a live Proxy over the runtime settings ref so reads from
 * `chainedCtx.config.<key>` always return the current value.
 *
 * @param {{ get: () => any }} runtime
 */
function liveConfig(runtime) {
  return new Proxy({}, {
    get(_t, key) {
      const s = runtime.get()
      if (!s || typeof s !== 'object') return undefined
      return s[key]
    },
    has(_t, key) {
      const s = runtime.get()
      if (!s || typeof s !== 'object') return false
      return Object.prototype.hasOwnProperty.call(s, key)
    },
  })
}

export async function apply(ctx, config) {
  const logger = createLogger(ctx, { keys: [] })

  const web = typeof ctx.get === 'function' ? ctx.get('web') : null
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  if (!web || !tools) {
    logger.warn('web-access-chain.apply', { phase: 'init' }, 'web/tools services unavailable — skipping registration')
    return
  }

  // ── 1. Register settings namespace. Reuse the real SettingsScope
  //    returned by settings.register (C1) and own a single mutable
  //    runtime ref that the watcher updates.
  let settingsHandle = null
  try {
    settingsHandle = registerSettings(ctx, { base: config })
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    logger.warn('web-access-chain.apply', { phase: 'settings' }, msg)
  }
  const runtimeSettings = createRuntimeSettings(settingsHandle, (settingsHandle && settingsHandle.get()) || readSettings(ctx) || {})

  // ── 2. Subscribe to live settings updates. The same handler covers
  //    gated-tool reconcile and any other consumer.
  if (settingsHandle && typeof settingsHandle.watch === 'function') {
    safeRegister(ctx, logger, 'settings.watch', () => settingsHandle.watch((next) => {
      runtimeSettings.replace(next)
      reconcileToolGates(runtimeSettings)
      reconcileAdapterGates(runtimeSettings)
    }))
  }

  // ── 3. Build the chained ctx once against a live Proxy. The proxy
  //    delegates every read to `runtimeSettings.get()`, so the chain
  //    reflects the live settings on every dispatch.
  const liveCfg = liveConfig(runtimeSettings)
  const chainedCtx = {
    ctx,
    settings: liveCfg,
    rawConfig: liveCfg,
    config: liveCfg,
    resolved: {},
    keysForRedaction: [],
  }

  // ── 4. System-prompt section
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    safeRegister(ctx, logger, 'systemPrompt', () => systemPrompt.section({
      name: 'dsh-web-search-chained:tool-guidance',
      order: 100,
      text: TOOL_GUIDANCE,
    }))
  }

  // ── 5. Register search provider. available() stays true per C2.
  safeRegister(ctx, logger, 'search-provider', () => web.registerSearchProvider({
    id: 'web-access-chain-search',
    available() { return true },
    async search(request, signal) {
      try {
        return await chainedSearch(request || { query: '' }, signal, chainedCtx)
      } catch (e) {
        loggerWithKeys(logger, chainedCtx.keysForRedaction).error('chained.search', e, { phase: 'fail' })
        throw e
      }
    },
  }))

  // ── 6. Register fetch provider. available() stays true per C2.
  safeRegister(ctx, logger, 'fetch-provider', () => web.registerFetchProvider({
    id: 'web-access-chain-fetch',
    available() { return true },
    async fetch(request, signal) {
      try {
        const settings = runtimeSettings.get()
        return await chainedFetch(request, signal, {
          ssrf: (settings && settings.ssrf) || { allowRanges: [], trustEnvProxy: false },
          domainPolicy: (settings && settings.domainPolicy) || { allow: [], deny: [] },
          maxBytes: ((settings && settings.fetchMaxResponseMB) || 5) * 1024 * 1024,
          settings,
          ctx,
        })
      } catch (e) {
        loggerWithKeys(logger, chainedCtx.keysForRedaction).error('chained-fetch.fetch', e, { phase: 'fail' })
        throw e
      }
    },
  }))

  // ── 7. Register the slim default Tool surface (SPEC §I.5) ───────
  const toolsCtx = {
    ctx,
    settings: liveCfg,
    chainedCtx,
    web,
    probe: createProbe(ctx, runtimeSettings.get()),
  }
  // Keep toolsCtx.settings / probe in sync with each fresh snapshot.
  safeRegister(ctx, logger, 'tools.refresh', () => {
    const refresh = () => {
      const s = runtimeSettings.get()
      toolsCtx.settings = liveCfg
      toolsCtx.probe = createProbe(ctx, s || {})
    }
    const stop = settingsHandle && typeof settingsHandle.watch === 'function'
      ? settingsHandle.watch(refresh)
      : null
    return () => { try { stop && stop() } catch { /* ignore */ } }
  })

  safeRegister(ctx, logger, 'tools.web_search_ex', () => tools.register(createWebSearchEx(toolsCtx)))
  safeRegister(ctx, logger, 'tools.search_content', () => tools.register(createSearchContent(toolsCtx)))
  safeRegister(ctx, logger, 'tools.source_check', () => tools.register(createSourceCheck(toolsCtx)))
  safeRegister(ctx, logger, 'tools.web_doctor', () => tools.register(createWebDoctor(toolsCtx)))

  // Gated specialised Tools (SPEC §II.5 / acceptance #14).
  const gatingSpecs = [
    {
      label: 'tools.github_pr_issue',
      settingsKey: (s) => !!(s && s.tools && s.tools.githubPrIssue && s.tools.githubPrIssue.enabled === true),
      create: () => createGithubPrIssue(toolsCtx),
    },
    {
      label: 'tools.video_extract',
      settingsKey: (s) => !!(s && s.tools && s.tools.videoExtract && s.tools.videoExtract.enabled === true),
      create: () => createVideoExtract(toolsCtx),
    },
    {
      label: 'tools.pdf_extract',
      settingsKey: (s) => !!(s && s.tools && s.tools.pdfExtract && s.tools.pdfExtract.enabled === true),
      create: () => createPdfExtract(toolsCtx),
    },
  ]
  for (const g of gatingSpecs) {
    registerToolIfEnabled({
      ctx,
      runtime: runtimeSettings,
      settingsKey: g.settingsKey,
      create: g.create,
      register: (t) => tools.register(t),
      tools,
      label: g.label,
      safeRegister: (fn) => safeRegister(ctx, logger, g.label, fn),
    })
  }

  // ── 8. Skills
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : null
  if (skills && typeof skills.register === 'function') {
    safeRegister(ctx, logger, 'skills.web-access', () => registerWebAccessSkill(ctx, skills))
    safeRegister(ctx, logger, 'skills.web-access-doctor', () => registerWebAccessDoctorSkill(ctx, skills))
  }

  // ── 9. Commands
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : null
  if (commands && typeof commands.register === 'function') {
    safeRegister(ctx, logger, 'commands.webdoctor', () => commands.register(createWebDoctorCmd(toolsCtx)))
    safeRegister(ctx, logger, 'commands.webcache', () => commands.register(createWebCacheCmd(toolsCtx)))
    safeRegister(ctx, logger, 'commands.webdoctor-keys', () => commands.register(createWebDoctorKeysCmd(toolsCtx)))
  }

  logger.info('web-access-chain.init', { phase: 'done', settings: runtimeSettings.get() ? Object.keys(runtimeSettings.get()).length : 0 })
}

/**
 * Reconcile adapter gates. Currently the adapter side does not register
 * its own disposers — the gate is consulted at call time inside
 * matchSpecializedAdapter / chained-fetch. Kept here so commit 4 can
 * attach a side-channel (UI refresh) without restructuring apply().
 */
function reconcileAdapterGates(/* runtime */) { /* no-op for commit 2 */ }

/**
 * Re-evaluate each gated Tool's enable flag against the new runtime
 * settings snapshot. Implementation lives inside registerIfEnabled;
 * this is a forward-looking hook so future commits can notify the UI.
 */
function reconcileToolGates(/* runtime */) { /* no-op for commit 2; the watcher drives the per-tool reconcile */ }

function loggerWithKeys(base, keys) {
  if (!base) return null
  return {
    debug: (msg, m) => base.debug(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    info: (msg, m) => base.info(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    warn: (msg, e, m) => base.warn(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, e, m),
    error: (msg, e, m) => base.error(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, e, m),
  }
}

// re-exported for test usage; not part of the host seam surface.
export { readSettings, patchSetting }
