// test/gated-tools.test.js — gated specialised Tools (Commit 3).
//
// Each tool is gated by its own settings.tools.*.enabled flag. The
// tools are NOT registered by apply() when the flag is false.

import { test } from 'node:test'
import assert from 'node:assert/strict'

function makeStubCtx(toolsCfg = {}) {
  const state = {
    searchProviders: new Map(),
    fetchProviders: new Map(),
    toolsRegistered: new Set(),
    commandsRegistered: new Set(),
    settingsRegistered: new Set(),
    skillsRegistered: new Set(),
    systemPromptSections: 0,
  }
  return {
    session: { id: 'session-A' },
    state,
    get(key) {
      const stub = {
        web: {
          registerSearchProvider(p) { state.searchProviders.set(p.id, p); return () => state.searchProviders.delete(p.id) },
          registerFetchProvider(p) { state.fetchProviders.set(p.id, p); return () => state.fetchProviders.delete(p.id) },
        },
        tools: { register(d) { state.toolsRegistered.add(d.name); return () => state.toolsRegistered.delete(d.name) } },
        commands: { register(d) { state.commandsRegistered.add(d.name); return () => state.commandsRegistered.delete(d.name) } },
        skills: { register(d) { state.skillsRegistered.add(d.name); return () => state.skillsRegistered.delete(d.name) } },
        settings: {
          register(ns) { state.settingsRegistered.add(ns); return { get: () => ({}), update: async () => {}, replace: async () => {} } },
          get(ns) {
            if (ns === 'dsh.profile') return { id: 'p1' }
            return {
              tools: { ...toolsCfg },
              ssrf: { allowRanges: [], trustEnvProxy: false },
              domainPolicy: { allow: [], deny: [] },
            }
          },
          update: async () => {},
        },
        credentials: { resolve: async () => null, set: async () => {} },
        agents: { currentInitiator() { return { sessionId: 'session-A' } } },
        storage: { form(name) { if (name === 'default' || !name) return { async put(){}, async get(){return undefined} }; return null } },
        systemPrompt: { section() { return () => {} } },
        agentDefaultModel: { currentSelection() { return { provider: 'minimax-cn' } } },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      }
      return stub[key] || null
    },
    effect(fn) {
      const d = fn()
      return () => { try { if (typeof d === 'function') d() } catch {} }
    },
  }
}

test('gated tools are NOT registered when settings.tools.*.enabled !== true', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = makeStubCtx({})
  await apply(ctx, {})
  // github_pr_issue / video_extract / pdf_extract default to enabled:false
  assert.equal(ctx.state.toolsRegistered.has('github_pr_issue'), false)
  assert.equal(ctx.state.toolsRegistered.has('video_extract'), false)
  assert.equal(ctx.state.toolsRegistered.has('pdf_extract'), false)
  // The 4 default surface tools ARE registered
  assert.equal(ctx.state.toolsRegistered.has('web_search_ex'), true)
  assert.equal(ctx.state.toolsRegistered.has('search_content'), true)
  assert.equal(ctx.state.toolsRegistered.has('source_check'), true)
  assert.equal(ctx.state.toolsRegistered.has('web_doctor'), true)
})

test('github_pr_issue IS registered when settings.tools.githubPrIssue.enabled === true', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = makeStubCtx({ githubPrIssue: { enabled: true } })
  await apply(ctx, {})
  assert.equal(ctx.state.toolsRegistered.has('github_pr_issue'), true)
})

test('video_extract IS registered when settings.tools.videoExtract.enabled === true', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = makeStubCtx({ videoExtract: { enabled: true } })
  await apply(ctx, {})
  assert.equal(ctx.state.toolsRegistered.has('video_extract'), true)
})

test('pdf_extract IS registered when settings.tools.pdfExtract.enabled === true', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = makeStubCtx({ pdfExtract: { enabled: true, provider: 'unpdf' } })
  await apply(ctx, {})
  assert.equal(ctx.state.toolsRegistered.has('pdf_extract'), true)
})

test('github_pr_issue throws CONFIG when invoked without the gate enabled', async () => {
  const { createTool: createGithubPrIssue } = await import('../lib/tools/github-pr-issue.js')
  const def = createGithubPrIssue({
    ctx: { get: () => null },
    settings: { tools: { githubPrIssue: { enabled: false } } },
  })
  await assert.rejects(
    def.execute({ url: 'https://github.com/o/r/pull/1' }, { signal: new AbortController().signal }),
    (e) => e.code === 'CONFIG' && /disabled/i.test(e.message),
  )
})

test('pdf_extract throws CONFIG when invoked without the gate enabled', async () => {
  const { createTool: createPdfExtract } = await import('../lib/tools/pdf-extract.js')
  const def = createPdfExtract({
    ctx: { get: () => null },
    settings: { tools: { pdfExtract: { enabled: false } } },
  })
  await assert.rejects(
    def.execute({ url: 'https://example.com/file.pdf' }, { signal: new AbortController().signal }),
    (e) => e.code === 'CONFIG' && /disabled/i.test(e.message),
  )
})

test('video_extract throws CONFIG when invoked without the gate enabled', async () => {
  const { createTool: createVideoExtract } = await import('../lib/tools/video-extract.js')
  const def = createVideoExtract({
    ctx: { get: () => null },
    settings: { tools: { videoExtract: { enabled: false } } },
  })
  await assert.rejects(
    def.execute({ filePath: '/tmp/example.mp4' }, { signal: new AbortController().signal }),
    (e) => e.code === 'CONFIG' && /disabled/i.test(e.message),
  )
})
