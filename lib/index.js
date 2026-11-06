// lib/index.js — DSH Trinity v2.4.3 entry point.
//
// v2.4.3 (DSH 0.2.1 conformance):
//   - `inject` declares only the services the plugin cannot work without
//     (`web`, `tools`, `systemPrompt`). The optional services (`settings`,
//     `credentials`, `agents`) are resolved at use time, so a composition
//     without one of them no longer keeps the whole plugin from starting —
//     silently, with no log.
//   - A missing `skills` / `commands` service is now REPORTED in the log
//     instead of silently skipping the two skills and the three slash
//     commands.
//   - The logger facade takes (message, meta): a third argument was being
//     dropped, so every warning lost its explanation. The explanation now
//     lives in the message.
//   - The external-binary adapters (gh, yt-dlp, ffprobe, opencli) now run
//     through the HOST subprocess seam (see lib/util/subprocess.js); the
//     node:child_process fallback that escaped the Host's process
//     containment is gone.
//
// v2.4.1 (config-plumbing fix): the entry now exports the Cordis `Config`
// schema. DSH >= 0.1.7 replaced the old `SettingsProvider`
// (`register`/`get`/`watch`) with `SettingsForms` (`configure`/`describe`/
// `update`/`replace`/`mutate`), so the previous `settings.register(...)`
// call silently no-opped and every value from `cordis.patch.yml` was
// dropped — the plugin ran on code defaults. With `Config` exported the
// Loader resolves schema defaults over the row's raw config, hands the
// result to `apply()`, and exposes the row in the native settings form.
// Volatile fields update in place (no restart); ordinary edits restart the
// fiber. See lib/settings/register.js and lib/settings/volatile.js.
//
// Wires the namespaced search/fetch providers (SPEC §II.9), the live
// settings reference (legacy SettingsScope on <= 0.1.6; volatile Config
// references on >= 0.1.7), the credential pool runner, the system-prompt
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
import { WebAccessChainSchema } from './config-schema.js'
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
export const version = '2.4.3'

// The Cordis entry Config schema. Exporting it is what makes configuration
// WORK on DSH >= 0.1.7: the Loader resolves schema defaults over this row's
// raw profile config and passes the result to `apply(ctx, config)`, and the
// `settings` service (describe/update/mutate) keys the row's editable form
// off it. Without this export `apply()` received the raw patch and the
// plugin silently ran on code defaults (see lib/settings/register.js).
export const Config = WebAccessChainSchema

// Inject ONLY the services the plugin cannot work without.
//
// DSH 0.2.1-rc.5 composition reality (verified against the installed
// packages and the live host):
//   - `web`, `tools` and `systemPrompt` are core services; every DSH
//     composition mounts them, and the plugin's provider registration, tool
//     surface and prompt guidance all depend on them.
//   - `settings`, `credentials`, `agents`, `skills` and `commands` are
//     OPTIONAL here: the code degrades when they are missing. Declaring
//     them as hard dependencies used to make the whole plugin fail to
//     start (silently, with no log) whenever one was absent — and NOT
//     declaring `skills`/`commands` used to make their absence silent
//     too. The optional services are now resolved at use time and their
//     absence is reported in the log instead of vanishing.
export const inject = ['web', 'tools', 'systemPrompt']

function safeRegister(ctx, logger, label, fn) {
  try {
    return ctx.effect(fn)
  } catch (e) {
    const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : '')
    // The logger facade takes (message, meta): a second argument that is not
    // an Error is the metadata and a THIRD argument would be dropped, so the
    // explanation belongs in the message itself.
    logger.warn(`web-access-chain.apply: ${msg}`, { phase: label })
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
    logger.warn('web-access-chain.apply: web/tools services unavailable — skipping registration', { phase: 'init' })
    return
  }

  // ── 1. Adopt the resolved configuration. On DSH >= 0.1.7 the Loader has
  //    already validated `config` against the exported `Config` schema and
  //    filled every default; volatile fields are LIVE references, so the
  //    runtime ref below re-reads them on every access (a settings edit
  //    updates them in place — `loader/volatile-update` — without restarting
  //    this fiber). Ordinary config changes restart the fiber, which re-runs
  //    this whole function. On legacy hosts (<= 0.1.6) `settings.register`
  //    still yields a live scope that pushes whole objects.
  const declaredConfig = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {}
  let settingsHandle = null
  try {
    settingsHandle = registerSettings(ctx, { base: declaredConfig })
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    logger.warn(`web-access-chain.apply: ${msg}`, { phase: 'settings' })
  }
  const runtimeSettings = createRuntimeSettings(
    settingsHandle,
    (settingsHandle && settingsHandle.get()) || readSettings(ctx) || declaredConfig
  )

  // ── 2. Legacy-only whole-object push. Modern hosts have no settings
  //    watcher: volatile edits land in the references the runtime ref reads
  //    through, and ordinary edits restart the fiber. The gated-tool
  //    reconcile lives inside registerIfEnabled's own watcher, so this
  //    top-level watcher only refreshes the in-memory ref.
  if (settingsHandle && settingsHandle.source === 'scope' && typeof settingsHandle.watch === 'function') {
    safeRegister(ctx, logger, 'settings.watch', () => settingsHandle.watch((next) => {
      runtimeSettings.replace(next)
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
  // `settings` and `probe` hold the LIVE proxy, not a snapshot: on modern
  // hosts a settings edit updates the volatile references in place without
  // restarting this fiber, so anything captured by value would go stale.
  const toolsCtx = {
    ctx,
    settings: liveCfg,
    chainedCtx,
    web,
    probe: createProbe(ctx, liveCfg),
  }

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

  // ── 8. Skills — an OPTIONAL dependency.
  //
  // `ctx.inject([...], cb)` is the Host's own pattern for an optional
  // service (@deepseek-ai/dsh-settings README: "a plugin must not depend
  // on it inside apply(); to use it, use an optional ctx.inject([...], …)
  // child"). The child fiber runs the moment the service appears, so a
  // service that mounts LATER is not lost — and a service that never
  // appears does not keep this plugin from starting.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      safeRegister(skillCtx, logger, 'skills.web-access', () => registerWebAccessSkill(skillCtx, skillCtx.skills))
      safeRegister(skillCtx, logger, 'skills.web-access-doctor', () => registerWebAccessDoctorSkill(skillCtx, skillCtx.skills))
    })
  }
  if (!ctx.get || !ctx.get('skills')) {
    logger.info('web-access-chain.apply: the host skills service is not mounted — the web-access skills register only if it appears',
      { phase: 'skills' })
  }

  // ── 9. Commands — an OPTIONAL dependency, same pattern as the skills.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      safeRegister(commandCtx, logger, 'commands.webdoctor', () => commandCtx.commands.register(createWebDoctorCmd(toolsCtx)))
      safeRegister(commandCtx, logger, 'commands.webcache', () => commandCtx.commands.register(createWebCacheCmd(toolsCtx)))
      safeRegister(commandCtx, logger, 'commands.webdoctor-keys', () => commandCtx.commands.register(createWebDoctorKeysCmd(toolsCtx)))
    })
  }
  if (!ctx.get || !ctx.get('commands')) {
    logger.info('web-access-chain.apply: the host commands service is not mounted — /webdoctor, /webcache and /webdoctor-keys register only if it appears',
      { phase: 'commands' })
  }

  logger.info('web-access-chain.init', { phase: 'done', settings: runtimeSettings.get() ? Object.keys(runtimeSettings.get()).length : 0 })
}

// P1#7 (review): the previous no-op reconcileAdapterGates / reconcileToolGates
// helpers were dead code — the gated tools reconcile inside their own
// scope watcher (lib/util/gated-register.js); the adapter gates are
// consulted at call time inside matchSpecializedAdapter / chained-fetch.
// Both helpers are removed; their former call sites just refresh the
// runtime ref.

function loggerWithKeys(base, keys) {
  if (!base) return null
  return {
    // The facade takes (message, meta) for debug/info/warn — a third
    // argument is dropped when the second one is a plain meta object — and
    // (message, err, meta) for error, which keeps the meta.
    debug: (msg, m) => base.debug(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    info: (msg, m) => base.info(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    warn: (msg, m) => base.warn(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, m),
    error: (msg, e, m) => base.error(typeof msg === 'string' ? redactAllCredentials(msg, keys) : msg, e, m),
  }
}

// re-exported for test usage; not part of the host seam surface.
export { readSettings, patchSetting }
