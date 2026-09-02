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
//                | { type: 'block-start' | 'block-end' | ... }
//
// The provider/model route comes from ctx.agentDefaultModel.currentSelection()
// (dsh-agent-default-model), NOT from a literal 'auto' route: 'auto' is not a
// registered adapter and prepareCall would throw NO_ADAPTER.
//
// Messages are hand-built ({ id, role, content: [{ type: 'text', text }],
// source: { kind: 'user' } }) so the plugin needs no import of the core
// @deepseek-ai/dsh-llm package (keeps the npm bundle self-contained).

let _msgCounter = 0

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
 * Run a one-shot completion through the DSH llm seam and assemble the
 * text output. Returns null (never throws) when the seam is unavailable,
 * the route is unknown, or the call fails — callers fall back.
 *
 * @param {any} ctx
 * @param {{
 *   system?: string,
 *   prompt: string,
 *   tools?: Array<{ name: string }>,
 *   modelOverride?: string | null,
 * }} opts
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<string | null>}
 */
export async function oneShotCompletion(ctx, opts, exec) {
  if (!ctx || typeof ctx.get !== 'function') return null
  const llm = ctx.get('llm')
  if (!llm || typeof llm.prepareCall !== 'function') return null
  const sel = currentModelSelection(ctx)
  if (!sel) return null

  const provider = sel.provider
  const model = (opts && typeof opts.modelOverride === 'string' && opts.modelOverride.length > 0)
    ? opts.modelOverride
    : sel.model
  const prompt = opts && opts.prompt ? opts.prompt : ''
  const signal = exec && exec.signal

  try {
    const prepared = await llm.prepareCall({ provider, model }, signal)
    if (!prepared || typeof prepared.stream !== 'function') return null
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
    const stream = prepared.stream(request)
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) {
        if (chunk && typeof chunk.text === 'string') out += chunk.text
      }
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}
