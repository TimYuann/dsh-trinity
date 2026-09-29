// lib/llm-call.js — one-shot LLM completion helper against the real DSH
// llm seam (verified against @deepseek-ai/dsh-llm).
//
// Seam contract (dsh-llm/lib/types):
//   ctx.llm.prepareCall(config, signal) → PreparedLlmCall
//     config = LlmCallConfig { provider, model, reasoningEffort?, temperature?,
//                              maxTokens?, stop? }   // NO messages / tools here
//   prepared.stream(request) → AsyncIterable<StreamChunk>
//     request = GenerateOptions { provider, model, messages, system?, tools?,
//                                 temperature?, maxTokens?, stop?, signal? }
//   StreamChunk: { type: 'text-delta', text } | { type: 'reasoning-delta', text }
//                | { type: 'usage', usage } | { type: 'block-start' | 'block-end' }
//                | { type: 'finish', reason: { kind: 'stop' | 'error', failure? } }
//
// The provider/model route comes from ctx.agentDefaultModel.currentSelection()
// (dsh-agent-default-model), NOT from a literal 'auto' route: 'auto' is not a
// registered adapter and prepareCall would throw NO_ADAPTER.
//
// v2.4.2 — FAILURES ARE NO LONGER SILENT. A stream can COMPLETE NORMALLY while
// carrying a provider failure inside its `finish` chunk (no throw, no text):
// the `opencode-go` endpoint answers 400 `MissingSessionID` that way, and the
// old reader saw only "no text" and fell back to heuristics with no
// explanation. `oneShotCompletionReport` now returns that reason, callers
// surface it, and `auxLlm` (lib/config-schema.js) lets the auxiliary calls —
// answer synthesis, sub-query decomposition, source assessment — use a route
// that works even when the session's default model refuses plugin calls.
//
// Messages are hand-built ({ id, role, content: [{ type: 'text', text }],
// source: { kind: 'user' } }) so the plugin needs no import of the core
// @deepseek-ai/dsh-llm package (keeps the npm bundle self-contained).

let _msgCounter = 0

const MAX_ERROR_CHARS = 240

/**
 * Build one identified user message in the DSH Message shape without
 * importing @deepseek-ai/dsh-llm.
 *
 * @param {string} text
 * @returns {{ id: string, role: 'user', content: [{ type: 'text', text: string }], source: { kind: 'user' } }}
 */
export function buildUserMessage(text) {
  _msgCounter += 1
  return {
    id: `dswc-${Date.now().toString(36)}-${_msgCounter}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Read the current default model route (provider + model) from the
 * agentDefaultModel seam. Returns null when unavailable.
 *
 * @param {any} ctx
 * @returns {{ provider: string, model: string } | null}
 */
export function currentModelSelection(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const adm = ctx.get('agentDefaultModel')
  if (!adm || typeof adm.currentSelection !== 'function') return null
  try {
    const s = adm.currentSelection()
    if (s && typeof s.provider === 'string' && s.provider.length > 0 &&
        typeof s.model === 'string' && s.model.length > 0) {
      return { provider: s.provider, model: s.model }
    }
  } catch {
    // ignore — selection may be transiently uninitialized
  }
  return null
}

/**
 * Read the optional auxiliary LLM route (`auxLlm`) from live settings.
 *
 * Auxiliary calls are the plugin's OWN completions — answer synthesis,
 * sub-query decomposition, source assessment — never the agent loop's model
 * turns. A deployment whose default route refuses plugin-originated calls
 * (for example an endpoint that demands a per-session header) can point them
 * at a route that works, without changing the session model.
 *
 * @param {any} settings
 * @returns {{ provider: string | null, model: string | null }}
 */
export function auxRouteFromSettings(settings) {
  const aux = (settings && typeof settings === 'object') ? settings.auxLlm : null
  const pick = (value) => (typeof value === 'string' && value.trim().length > 0) ? value.trim() : null
  return { provider: pick(aux && aux.provider), model: pick(aux && aux.model) }
}

/**
 * Trim and bound a provider failure message so it can appear in a tool
 * result without dumping an unbounded upstream body.
 *
 * @param {any} value
 * @returns {string}
 */
function shortMessage(value) {
  const text = (value === undefined || value === null) ? '' : String(value)
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS)}…` : oneLine
}

/**
 * Run a one-shot completion through the DSH llm seam, returning both the
 * text and — when no text was produced — the reason.
 *
 * Never throws. `text` is null unless the model produced visible text.
 *
 * @param {any} ctx
 * @param {{
 *   system?: string,
 *   prompt: string,
 *   tools?: Array<{ name: string }>,
 *   modelOverride?: string | null,
 *   provider?: string | null,
 *   model?: string | null,
 * }} opts
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<{ text: string | null, error: { code: string, message: string } | null, route: { provider: string, model: string } | null }>}
 */
export async function oneShotCompletionReport(ctx, opts, exec) {
  const unavailable = (code, message) => ({ text: null, error: { code, message: shortMessage(message) }, route: null })
  if (!ctx || typeof ctx.get !== 'function') return unavailable('NO_CONTEXT', 'no plugin context')
  const llm = ctx.get('llm')
  if (!llm || typeof llm.prepareCall !== 'function') return unavailable('NO_LLM_SERVICE', 'ctx.llm.prepareCall is unavailable')
  const sel = currentModelSelection(ctx)

  const provider = (opts && typeof opts.provider === 'string' && opts.provider.length > 0)
    ? opts.provider
    : (sel && sel.provider)
  const model = (opts && typeof opts.modelOverride === 'string' && opts.modelOverride.length > 0)
    ? opts.modelOverride
    : ((opts && typeof opts.model === 'string' && opts.model.length > 0) ? opts.model : (sel && sel.model))
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) {
    return unavailable('NO_MODEL_ROUTE', 'no default model route is configured')
  }
  const route = { provider, model }

  const prompt = opts && opts.prompt ? opts.prompt : ''
  const signal = exec && exec.signal

  try {
    const prepared = await llm.prepareCall({ provider, model }, signal)
    if (!prepared || typeof prepared.stream !== 'function') {
      return { text: null, error: { code: 'NO_STREAM', message: 'prepared call exposes no stream()' }, route }
    }
    // The prepared call carries the resolved call config (provider/model
    // plus adapter-resolved reasoningEffort / maxTokens / …). stream()
    // validates that the request's scalar fields EQUAL the resolved
    // config (callConfigEquals), so the request must be built on top of
    // prepared.config — a bare { provider, model, messages } request
    // would throw INVALID_PREPARED_CALL and silently lose the answer.
    const base = (prepared.config && typeof prepared.config === 'object') ? prepared.config : { provider, model }
    const request = {
      ...base,
      messages: [buildUserMessage(prompt)],
      ...(opts && typeof opts.system === 'string' && opts.system.length > 0 ? { system: opts.system } : {}),
      ...(opts && Array.isArray(opts.tools) && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(signal ? { signal } : {}),
    }
    let out = ''
    let failure = null
    const stream = prepared.stream(request)
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (typeof chunk.text === 'string') out += chunk.text
        // A provider failure arrives as an ordinary `finish` chunk carrying
        // an error reason — the stream itself does not throw.
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          const f = chunk.reason.failure || {}
          failure = {
            code: String(f.code || 'PROVIDER_ERROR'),
            message: shortMessage(f.message || 'the provider reported an error'),
          }
        }
      }
    }
    if (out.length > 0) return { text: out, error: null, route }
    if (failure) {
      logFailure(ctx, { provider, model, code: failure.code }, failure.message)
      return { text: null, error: failure, route }
    }
    return { text: null, error: { code: 'EMPTY_RESPONSE', message: 'the model produced no text' }, route }
  } catch (e) {
    // Prefer the machine-routable code; a plain `Error` contributes nothing.
    const code = (e && e.code) ? String(e.code) : ((e && e.name && e.name !== 'Error') ? String(e.name) : 'LLM_CALL_FAILED')
    const message = shortMessage((e && e.message) ? e.message : e)
    logFailure(ctx, { provider, model, code }, message)
    return { text: null, error: { code, message }, route }
  }
}

/**
 * One line into the host log, so a degraded auxiliary call is visible
 * instead of vanishing into a silent heuristic fallback.
 *
 * @param {any} ctx
 * @param {{ provider: string, model: string, code: string }} meta
 * @param {string} message
 */
function logFailure(ctx, meta, message) {
  try {
    const log = ctx.get('logger')
    if (log && typeof log.warn === 'function') {
      log.warn('dsh-trinity llm-call failed', { phase: 'llm-call', ...meta }, message)
    }
  } catch { /* logging must never break the caller */ }
}

/**
 * Run a one-shot completion through the DSH llm seam and assemble the
 * text output. Returns null (never throws) when the seam is unavailable,
 * the route is unknown, or the call fails — callers fall back.
 *
 * Use `oneShotCompletionReport` when the caller can tell the user WHY the
 * call produced no text.
 *
 * @param {any} ctx
 * @param {{
 *   system?: string,
 *   prompt: string,
 *   tools?: Array<{ name: string }>,
 *   modelOverride?: string | null,
 *   provider?: string | null,
 *   model?: string | null,
 * }} opts
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<string | null>}
 */
export async function oneShotCompletion(ctx, opts, exec) {
  const report = await oneShotCompletionReport(ctx, opts, exec)
  return report.text
}
