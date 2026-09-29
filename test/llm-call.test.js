// test/llm-call.test.js — v2.4.2 auxiliary-LLM reporting.
//
// Regression coverage for the defect this release fixes: a provider can end
// a stream with an ERROR `finish` chunk while the stream itself completes
// normally. The old reader saw only "no text" and returned null, so
// `output:"answer"` silently fell back to raw sources and `source_check`
// silently used heuristics — with no hint that the model had been asked and
// the provider had refused. (Observed live on DSH 0.2.0-rc.2: the
// `opencode-go` endpoint answers 400 MissingSessionID for plugin-originated
// calls unless the request carries its per-session header.)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  oneShotCompletion,
  oneShotCompletionReport,
  auxRouteFromSettings,
  currentModelSelection,
} from '../lib/llm-call.js'
import { OUTPUT as SEARCH_OUTPUT } from '../lib/tools/web-search-ex.js'

/** Minimal ctx whose llm seam streams the supplied chunks. */
function makeCtx(chunks, opts = {}) {
  const warnings = []
  const preparedCalls = []
  const ctx = {
    warnings,
    preparedCalls,
    get(name) {
      if (name === 'logger') return { warn: (...args) => warnings.push(args) }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (opts.selection === undefined ? { provider: 'p1', model: 'm1' } : opts.selection) }
      }
      if (name === 'llm') {
        if (opts.noLlm) return undefined
        return {
          async prepareCall(config) {
            preparedCalls.push(config)
            if (opts.prepareThrows) throw Object.assign(new Error('no adapter registered for provider "p1"'), { code: 'NO_ADAPTER' })
            return {
              config,
              stream() {
                if (opts.streamThrows) throw new Error('stream blew up')
                return (async function* () { for (const c of chunks) yield c })()
              },
            }
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

test('llm-call: text deltas produce text and no error', async () => {
  const ctx = makeCtx([
    { type: 'block-start' },
    { type: 'text-delta', text: 'hello ' },
    { type: 'text-delta', text: 'world' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const report = await oneShotCompletionReport(ctx, { prompt: 'hi', tools: [] }, undefined)
  assert.equal(report.text, 'hello world')
  assert.equal(report.error, null)
  assert.deepEqual(report.route, { provider: 'p1', model: 'm1' })
  assert.deepEqual(ctx.preparedCalls, [{ provider: 'p1', model: 'm1' }])
})

test('llm-call: a finish-carried provider error is reported, not swallowed', async () => {
  const ctx = makeCtx([
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'INVALID_REQUEST',
          message: '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}',
        },
      },
    },
  ])
  const report = await oneShotCompletionReport(ctx, { prompt: 'hi', tools: [] }, undefined)
  assert.equal(report.text, null, 'no text means no answer')
  assert.equal(report.error.code, 'INVALID_REQUEST')
  assert.match(report.error.message, /MissingSessionID/)
  assert.equal(ctx.warnings.length, 1, 'the failure must reach the host log')
  assert.match(ctx.warnings[0][2], /MissingSessionID/)
})

test('llm-call: oneShotCompletion keeps its text-or-null contract', async () => {
  const ok = makeCtx([{ type: 'text-delta', text: 'ok' }])
  assert.equal(await oneShotCompletion(ok, { prompt: 'x' }, undefined), 'ok')
  const bad = makeCtx([{ type: 'finish', reason: { kind: 'error', failure: { code: 'E', message: 'nope' } } }])
  assert.equal(await oneShotCompletion(bad, { prompt: 'x' }, undefined), null)
})

test('llm-call: an empty stream is reported as EMPTY_RESPONSE', async () => {
  const ctx = makeCtx([{ type: 'block-start' }, { type: 'block-end' }])
  const report = await oneShotCompletionReport(ctx, { prompt: 'x' }, undefined)
  assert.equal(report.text, null)
  assert.equal(report.error.code, 'EMPTY_RESPONSE')
})

test('llm-call: prepareCall failures carry their code', async () => {
  const ctx = makeCtx([], { prepareThrows: true })
  const report = await oneShotCompletionReport(ctx, { prompt: 'x' }, undefined)
  assert.equal(report.error.code, 'NO_ADAPTER')
  assert.equal(ctx.warnings.length, 1)
})

test('llm-call: stream failures are caught, never thrown at the caller', async () => {
  const ctx = makeCtx([], { streamThrows: true })
  const report = await oneShotCompletionReport(ctx, { prompt: 'x' }, undefined)
  assert.equal(report.text, null)
  assert.equal(report.error.code, 'LLM_CALL_FAILED')
  assert.match(report.error.message, /stream blew up/)
})

test('llm-call: a missing seam and a missing route have distinct codes', async () => {
  assert.equal((await oneShotCompletionReport(makeCtx([], { noLlm: true }), { prompt: 'x' })).error.code, 'NO_LLM_SERVICE')
  assert.equal((await oneShotCompletionReport(makeCtx([], { selection: null }), { prompt: 'x' })).error.code, 'NO_MODEL_ROUTE')
  assert.equal((await oneShotCompletionReport(null, { prompt: 'x' })).error.code, 'NO_CONTEXT')
})

test('llm-call: an explicit route overrides the session default', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'ok' }])
  const report = await oneShotCompletionReport(ctx, { prompt: 'x', provider: 'deepseek-official', model: 'deepseek-chat' }, undefined)
  assert.equal(report.text, 'ok')
  assert.deepEqual(ctx.preparedCalls, [{ provider: 'deepseek-official', model: 'deepseek-chat' }])
  assert.deepEqual(report.route, { provider: 'deepseek-official', model: 'deepseek-chat' })
})

test('llm-call: modelOverride still wins over an explicit model', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'ok' }])
  await oneShotCompletionReport(ctx, { prompt: 'x', provider: 'p', model: 'm', modelOverride: 'override' }, undefined)
  assert.deepEqual(ctx.preparedCalls, [{ provider: 'p', model: 'override' }])
})

test('llm-call: a route works even with no agentDefaultModel selection', async () => {
  const ctx = makeCtx([{ type: 'text-delta', text: 'ok' }], { selection: null })
  const report = await oneShotCompletionReport(ctx, { prompt: 'x', provider: 'p2', model: 'm2' }, undefined)
  assert.equal(report.text, 'ok')
  assert.deepEqual(report.route, { provider: 'p2', model: 'm2' })
})

test('llm-call: currentModelSelection tolerates a broken seam', () => {
  assert.equal(currentModelSelection(null), null)
  assert.equal(currentModelSelection({ get: () => undefined }), null)
  assert.equal(currentModelSelection({ get: () => ({ currentSelection() { throw new Error('x') } }) }), null)
  assert.equal(currentModelSelection({ get: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }) }).provider, 'p')
})

test('config: auxLlm reads provider and model, ignoring blanks', () => {
  assert.deepEqual(auxRouteFromSettings(undefined), { provider: null, model: null })
  assert.deepEqual(auxRouteFromSettings({}), { provider: null, model: null })
  assert.deepEqual(auxRouteFromSettings({ auxLlm: { provider: '', model: '   ' } }), { provider: null, model: null })
  assert.deepEqual(
    auxRouteFromSettings({ auxLlm: { provider: 'deepseek-official', model: 'deepseek-chat' } }),
    { provider: 'deepseek-official', model: 'deepseek-chat' },
  )
})

test('search tool: answer failures are rendered instead of looking like an answer', () => {
  const blocks = SEARCH_OUTPUT.render(
    { query: 'q', output: 'answer' },
    {
      sources: [{ url: 'https://example.com/', title: 'Example' }],
      answer: 'provider: exa fallback text',
      answerError: { code: 'INVALID_REQUEST', message: '400 MissingSessionID' },
      provider: 'exa',
    },
  )
  const text = blocks.map((b) => b.text).join('\n')
  assert.match(text, /answer synthesis unavailable \(INVALID_REQUEST\)/)
  assert.match(text, /MissingSessionID/)
})
