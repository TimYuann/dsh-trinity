// lib/source-check/assess.js — final assessment via the DSH llm seam
// (SPEC §II.5 step 5). Runs a one-shot completion (lib/llm-call.js) with
// the selected passages + claim, returns one of supported | contradicted
// | mixed | insufficient.

import { oneShotCompletion, currentModelSelection } from '../llm-call.js'

/**
 * @param {string} claim
 * @param {Array<{ offset: number, length: number, text: string, label: 'supporting' | 'contradicting' | 'neutral' }>} passages
 * @param {{ ctx: any, settings?: any, assessmentModel?: string }} opts
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<{ assessment: 'supported' | 'contradicted' | 'mixed' | 'insufficient', assessmentModel: string, assessmentGeneratedAt: number }>}
 */
export async function assessClaim(claim, passages, opts, exec) {
  const ctx = opts && opts.ctx
  const settings = (opts && opts.settings && opts.settings.sourceCheck) || {}
  const selection = currentModelSelection(ctx)
  const modelId = (typeof settings.assessmentModel === 'string' && settings.assessmentModel.length > 0)
    ? settings.assessmentModel
    : (selection ? selection.model : 'none')

  if (!ctx || typeof ctx.get !== 'function' || !selection) {
    // No LLM available — degrade to heuristic.
    return {
      assessment: heuristicAssess(passages),
      assessmentModel: modelId || 'none',
      assessmentGeneratedAt: Date.now(),
    }
  }
  const passageBlock = passages
    .map((p, i) => `[${i + 1}] (${p.label}) ${p.text}`)
    .join('\n\n')
  const prompt = `Assess the following claim based ONLY on the passages below. Reply with exactly one of: supported, contradicted, mixed, insufficient.\n\nClaim: ${claim}\n\nPassages:\n${passageBlock}`
  const out = await oneShotCompletion(ctx, {
    prompt,
    tools: [],
    modelOverride: (modelId && modelId !== 'none' && modelId !== selection.model) ? modelId : null,
  }, exec)
  if (out === null) {
    return {
      assessment: heuristicAssess(passages),
      assessmentModel: modelId || 'none',
      assessmentGeneratedAt: Date.now(),
    }
  }
  const norm = out.toLowerCase().trim()
  let assessment = 'insufficient'
  if (norm.includes('supported') && !norm.includes('contradicted')) assessment = 'supported'
  else if (norm.includes('contradicted') && !norm.includes('supported')) assessment = 'contradicted'
  else if (norm.includes('mixed')) assessment = 'mixed'
  return {
    assessment,
    assessmentModel: modelId,
    assessmentGeneratedAt: Date.now(),
  }
}

/**
 * @param {Array<{ label: string }>} passages
 */
function heuristicAssess(passages) {
  const supporting = passages.filter((p) => p.label === 'supporting').length
  const contradicting = passages.filter((p) => p.label === 'contradicting').length
  if (supporting === 0 && contradicting === 0) return 'insufficient'
  if (supporting > contradicting * 1.5) return 'supported'
  if (contradicting > supporting * 1.5) return 'contradicted'
  return 'mixed'
}
