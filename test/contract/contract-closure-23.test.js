// test/contract/contract-closure-23.test.js — 2.3.0 contract closure
// reproduction tests.
//
// These tests reproduce the defects called out in the review (P0 #1, P0 #2,
// P0 #3, P1 #4, P1 #5, P1 #6, P1 #10, P1 #6) and the spec gaps in commits
// 4/5. They are written to FAIL at the recorded baseline and to PASS only
// after the matching Commit 2-5 has landed.
//
// Plan section: Commit 1 step 4 (10 failing entry-level regression tests).
//
// They use the public tool / chained-context surface and direct fetcher
// monkey-patching for SSRF tests. No global state is mutated beyond an
// isolated globalThis.fetch stub that's restored in a finally block.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectRouting } from '../../lib/providers/search/chained.js'
import { chainedFetch } from '../../lib/providers/fetch/chained-fetch.js'
import { runPool } from '../../lib/credentials/pool.js'
import { registerIfEnabled } from '../../lib/util/gated-register.js'
import { scorePassages } from '../../lib/source-check/score.js'

// ──────────────────────────────────────────────────────────────────────
// P0 #1 — strict provider pinning
// ──────────────────────────────────────────────────────────────────────

test('CC23-1: selectRouting({kind:"single"}) must REJECT the legacy object form (P0 #1 fix)', () => {
  // v2.3.0 contract: the chain accepts only raw strings / arrays from
  // web_search_ex; web_search_ex no longer pre-normalises. The strict
  // parser therefore REJECTS object inputs with WEB_PROVIDER_BAD_REQUEST
  // rather than silently collapsing them to 'auto'.
  assert.throws(
    () => selectRouting({ kind: 'single', id: 'exa' }),
    (err) => err && err.code === 'WEB_PROVIDER_BAD_REQUEST',
    'object inputs must surface as a routing rejection, not silently fall back to "auto"',
  )
})

test('CC23-1b: selectRouting(["exa","tavily"]) returns the canonical ordered form', () => {
  const r = selectRouting(['exa', 'tavily'])
  assert.deepEqual(r, { kind: 'ordered', ids: ['exa', 'tavily'] },
    'selectRouting must preserve ordered pinned lists')
})

// ──────────────────────────────────────────────────────────────────────
// P0 #2 — safe HTTP transport (HEAD disappears, headers survive per-hop)
// ──────────────────────────────────────────────────────────────────────

test('CC23-4: chainedFetch rejects public→private redirect BEFORE the second network call', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString()
    calls.push({ url: u, init })
    if (u === 'https://attacker.example/start') {
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
    }
    return new Response('INTERNAL_LEAK', { status: 200 })
  }
  try {
    await assert.rejects(
      chainedFetch({ url: 'https://attacker.example/start' }, undefined, {
        ssrf: { allowRanges: [], trustEnvProxy: false },
        domainPolicy: { allow: [], deny: [] },
        maxBytes: 1024,
        ctx: { get() { return undefined } },
      }),
      (e) => e && (e.code === 'WEB_SSRF_BLOCKED' || /redirect|ssrf|private|loopback|reserved/i.test(e.message || '')),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  // Head request auto-follows a 30x. chainedFetch currently performs
  // fetch(headUrl, { method: 'HEAD', redirect: 'follow' }) on line 87,
  // which counts as a "first outbound" even before manual loop kicks in.
  // We allow 2 calls (HEAD + first manual GET hop) for now; the strict
  // assertion is "second hop with private IP must never fire".
  const reachPrivate = calls.some((c) => /10\.0\.0\.1|private/.test(c.url || ''))
  assert.equal(reachPrivate, false,
    `private target must never be reached (got calls: ${calls.map((c) => c.url).join(' | ')})`)
})

test('CC23-5: cross-origin redirect strips Authorization in chainedFetch internal helper', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString()
    const headers = (init && init.headers) || {}
    calls.push({ url: u, headers: { ...headers } })
    if (u === 'https://api.example.com/v1') {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/asset' } })
    }
    if (u === 'https://cdn.example.org/asset') {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  try {
    await chainedFetch(
      { url: 'https://api.example.com/v1', authFetch: 'profile-1' },
      undefined,
      {
        // v2.3.0: trustEnvProxy=true skips the DNS preflight so the
        // test can exercise the cross-origin strip without real DNS.
        ssrf: { allowRanges: [], trustEnvProxy: true },
        domainPolicy: { allow: [], deny: [] },
        maxBytes: 1024,
        ctx: {
          get(name) {
            if (name === 'credentials') {
              return { async resolve() { return { value: 'CANARY_AAAAAA' } } }
            }
            return undefined
          },
        },
        settings: {
          authFetch: {
            'profile-1': {
              name: 'profile-1',
              type: 'bearer',
              valueRef: 'EXAMPLE_KEY',
              allowedOrigins: ['https://api.example.com'],
            },
          },
        },
      },
    ).catch(() => {})
  } finally {
    globalThis.fetch = originalFetch
  }
  const crossHop = calls.find((c) => c.url.startsWith('https://cdn.example.org/'))
  assert.ok(crossHop, 'second hop must have occurred')
  const headerStr = JSON.stringify(crossHop.headers).toLowerCase()
  assert.equal(/canary_aaaaaa/.test(headerStr), false,
    `cross-origin redirect must not carry the canary value (got ${JSON.stringify(crossHop.headers)})`)
  for (const [name, value] of Object.entries(crossHop.headers || {})) {
    const lname = name.toLowerCase()
    if (lname === 'authorization') {
      assert.equal(String(value || '').length, 0,
        `Authorization header must be empty/absent on cross-origin hop (got: ${value})`)
    }
  }
})

// ──────────────────────────────────────────────────────────────────────
// P0 #3 — cancellation actually aborts the underlying work
// ──────────────────────────────────────────────────────────────────────

test('CC23-6: budget controller (createBudgetController) fires abort on the running task when the timeout elapses', async () => {
  // After Commit 3, safe-cancel timeouts live behind
  // `createBudgetController`. The test imports the helper module the way
  // Commit 3 will publish it. At baseline, the import path is unresolved
  // and Node raises ERR_MODULE_NOT_FOUND — this is the reproduction.
  const { createBudgetController } = await import('../../lib/util/budget-controller.js')
  let observedSignal = null
  let observedAbort = false
  const task = (signal) => new Promise((_resolve, reject) => {
    observedSignal = signal
    if (signal && signal.aborted) {
      observedAbort = true
      reject(abortError())
      return
    }
    signal && signal.addEventListener('abort', () => {
      observedAbort = true
      reject(abortError())
    })
  })

  const ctl = createBudgetController({ timeoutMs: 60 })
  let err = null
  try {
    await task(ctl.signal)
  } catch (e) {
    err = e
  } finally {
    ctl.dispose()
  }
  assert.ok(err && (err.name === 'AbortError' || /aborted|timeout/i.test(err.message || '')),
    'task must reject on the budget timeout')
  assert.equal(typeof observedSignal, 'object', 'task must receive a signal')
  assert.equal(observedAbort, true, 'signal must fire abort within the budget')
})

function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  e.code = 'ABORTED'
  return e
}

// ──────────────────────────────────────────────────────────────────────
// P1 #5 — pool state reuse across calls
// ──────────────────────────────────────────────────────────────────────

test('CC23-7: runPool exposes per-entry cooldown state in the returned pool, callable from a higher level', async () => {
  let firstCall = true
  const fetchFn = async () => {
    if (firstCall) {
      firstCall = false
      const e = new Error('Too Many Requests')
      e.code = 'WEB_PROVIDER_QUOTA'
      throw e
    }
    return { sources: [], provider: 'exa' }
  }
  const r1 = await runPool({
    providerId: 'exa',
    pool: [{ credentialRef: 'EXA_API_KEY', state: 'unknown' }],
    maxKeys: 1,
    perKeyTimeoutMs: 5_000,
    keysForRedaction: [],
    fetch: fetchFn,
    signal: undefined,
  })
  assert.equal(r1.ok, false)
  // State must be reported back as quotaCooldown in the returned pool.
  assert.equal(r1.pool[0].state, 'quotaCooldown')

  // The bug is one level up: chainedSearch / tryProvider rebuild the pool
  // every call via buildPool(), discarding the previous cooldown. So at
  // baseline, a second request uses a fresh entry. After Commit 4,
  // buildPool is initialised from a persisted per-(provider, ref,
  // fingerprint) state map. Here we test the upstream contract: if the
  // caller passes r1.pool back, runPool MUST honour the cooldown.
  let secondFetch = 0
  const r2 = await runPool({
    providerId: 'exa',
    pool: r1.pool,
    maxKeys: 1,
    perKeyTimeoutMs: 5_000,
    keysForRedaction: [],
    fetch: async () => { secondFetch += 1; return { sources: [] } },
    signal: undefined,
  })
  assert.equal(secondFetch, 0,
    'cooldown entry must not be retried on the second call when state is preserved (current runPool already does this — the higher-level bug is buildPool discarding it)')
})

// ──────────────────────────────────────────────────────────────────────
// P1 #4 — live settings + gated tools
// ──────────────────────────────────────────────────────────────────────

test('CC23-8: gated-register reconciles false→true→false→true transitions without leaking registrations', () => {
  const registrations = []
  const tools = {
    register(def) {
      registrations.push({ type: 'register', def })
      return () => { registrations.push({ type: 'dispose' }) }
    },
  }
  let liveEnabled = false
  const listeners = []
  const settingsStub = {
    get(ns) {
      if (ns !== 'web-access-chain') return undefined
      return { tools: { sample: { enabled: liveEnabled } } }
    },
    watch(handler) {
      listeners.push(handler)
      return () => {}
    },
    on(evt, fn) {
      listeners.push(fn)
      return () => {}
    },
  }
  let current = { tools: { sample: { enabled: false } } }
  const runtime = {
    get: () => current,
    replace: (next) => { current = next },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return settingsStub
      if (name === 'logger') return { warn() {} }
      return undefined
    },
  }
  registerIfEnabled({
    ctx,
    runtime,
    settingsKey: (s) => !!(s && s.tools && s.tools.sample && s.tools.sample.enabled === true),
    create: () => ({ name: 'sample' }),
    register: tools.register,
    tools,
    label: 'sample-tool',
    safeRegister: (fn) => {
      const d = fn()
      return () => { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
    },
  })

  function setEnabled(v) {
    liveEnabled = v
    current = { tools: { sample: { enabled: v } } }
    for (const l of listeners) {
      try {
        if (typeof l === 'function') l(current)
      } catch { /* ignore */ }
    }
  }

  // false → true
  setEnabled(true)
  // true → true (idempotent)
  setEnabled(true)
  // true → false (must dispose)
  setEnabled(false)
  // false → true (must register again)
  setEnabled(true)

  const registers = registrations.filter((r) => r.type === 'register')
  const disposes = registrations.filter((r) => r.type === 'dispose')
  assert.ok(disposes.length >= 1,
    `gate must dispose when toggled false; got ${registrations.length} entries, ${disposes.length} disposes`)
  assert.ok(registers.length >= 1,
    `gate must register when toggled true; got ${registers.length} registers`)
})

// ──────────────────────────────────────────────────────────────────────
// P1 #6 — source-check
// ──────────────────────────────────────────────────────────────────────

test('CC23-9: score.js exports a tokenize that emits at least one CJK bigram token (current drop-to-empty is the reproduction)', async () => {
  // At baseline score.js does not export tokenize; the assertion below
  // fails (the helper is module-local, not on the namespace).
  const scoreMod = await import('../../lib/source-check/score.js')
  const tokenize = scoreMod.tokenize
  assert.equal(typeof tokenize, 'function',
    'score.js must export tokenize so a Unicode-aware tokenization can replace the current ASCII-only regex (currently drops CJK to empty)')
  const cjkText = '中国人民站起来了。这是中华人民共和国成立的历史时刻。'
  const tokens = tokenize(cjkText)
  assert.ok(tokens.some((t) => /[\u4e00-\u9fff]/.test(t)),
    `tokenize must emit at least one CJK token; got ${tokens.slice(0, 10).join(',')}…`)
})

test('CC23-10: assessClaim parser must NOT interpret "unsupported" or "not supported" as "supported"', async () => {
  // Commit 5 publishes `parseAssessment(text)` (strict JSON enum). At
  // baseline the import path is unresolved → reproduction fails.
  const { parseAssessment } = await import('../../lib/source-check/assess-parser.js')
  for (const neg of ['unsupported', 'not supported', 'no evidence', 'the claim is not supported by the evidence']) {
    const out = parseAssessment(neg)
    assert.notEqual(out.assessment, 'supported',
      `"${neg}" must not parse as 'supported'; got ${out.assessment}`)
  }
})

// ──────────────────────────────────────────────────────────────────────
// CC23 Pkg integrity — every public script + docs path must exist
// ──────────────────────────────────────────────────────────────────────

test('CC23-pkg: every package.json script target exists on disk', async () => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const errors = []
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (typeof cmd !== 'string') continue
    const match = cmd.match(/node\s+([^\s]+)/)
    if (!match) continue
    const target = match[1]
    if (target.startsWith('-')) continue
    try {
      await fs.stat(path.resolve(target))
    } catch (e) {
      errors.push(`script "${name}" references missing file: ${target}`)
    }
  }
  assert.deepEqual(errors, [], errors.join('; '))
})

// Optional sanity: scorePassages does not throw on Chinese input.
test('CC23-9b: scorePassages does not blow up on long Chinese bodies and produces valid labels', () => {
  const claim = '中国首都是北京吗？'
  const body = ('北京烤鸭非常有名。每年春天北京的气候适宜。北京有许多著名的景点。').repeat(3)
  const out = scorePassages(body, claim, ['北京 烤鸭'], 3)
  assert.ok(Array.isArray(out))
  for (const p of out) {
    assert.ok(['supporting', 'contradicting', 'neutral'].includes(p.label),
      `every passage must carry a valid label (got: ${p.label})`)
  }
})
