// test/adapters/x.test.js — the X adapter's security and degradation
// contract.
//
// The load-bearing assertions here are not "does it fetch". They are:
//   1. No byte of a request URL can change which opencli SUBCOMMAND runs.
//   2. The adapter is unreachable unless settings explicitly opt in.
//   3. The URL that opencli actually visits must satisfy policy too —
//      not just the URL the caller typed.
//   4. Backend failure degrades to the public page VISIBLY, and only for
//      reasons on an allowlist; policy denials and aborts never degrade.
//   5. Broken backend output never becomes a successful EMPTY list.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chainedFetch } from '../../lib/providers/fetch/chained-fetch.js'
import { fakeHostContext } from '../helpers/fake-subprocess.js'
import { matchSpecializedAdapter } from '../../lib/adapters/index.js'
import * as x from '../../lib/adapters/x.js'

// ── Helpers ──────────────────────────────────────────────────────────

const POLICY = {
  ssrf: { allowRanges: [], trustEnvProxy: false },
  domainPolicy: { allow: [], deny: [] },
}

/**
 * Install a fake `opencli` on PATH. Returns { dir, argvFile, restore }.
 * The fake records the argv it received so a test can assert the EXACT
 * command shape rather than a substring of it.
 *
 * @param {{ stdout?: string, exitCode?: number, version?: string }} opts
 */
function installShim(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x-shim-'))
  const argvFile = join(dir, 'argv.txt')
  const stdout = opts.stdout !== undefined ? opts.stdout : '[{"id":"111","text":"hello world","url":"https://x.com/karpathy/status/111"}]'
  const exitCode = opts.exitCode !== undefined ? opts.exitCode : 0
  const version = opts.version !== undefined ? opts.version : '1.8.8'

  // A shell script, not a JS file: spawn() executes it directly.
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  echo "${version}"`,
    '  exit 0',
    'fi',
    `printf '%s\\n' "$@" > "${argvFile}"`,
    `cat <<'XEOF'`,
    stdout,
    'XEOF',
    `exit ${exitCode}`,
    '',
  ].join('\n')

  const bin = join(dir, 'opencli')
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)

  const saved = process.env.PATH
  process.env.PATH = `${dir}:${saved}`
  x.resetProvenanceCache()
  x.resetSerialization()

  return {
    dir,
    argvFile,
    argv() {
      if (!existsSync(argvFile)) return null
      return readFileSync(argvFile, 'utf8').split('\n').filter((s) => s.length > 0)
    },
    restore() {
      process.env.PATH = saved
      x.resetProvenanceCache()
      x.resetSerialization()
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

/**
 * Remove `opencli` from PATH entirely, so a spawn fails with ENOENT.
 * Returns { restore }.
 */
function installEmptyPath() {
  const dir = mkdtempSync(join(tmpdir(), 'x-nopath-'))
  const saved = process.env.PATH
  process.env.PATH = dir
  x.resetProvenanceCache()
  x.resetSerialization()
  return {
    restore() {
      process.env.PATH = saved
      x.resetProvenanceCache()
      x.resetSerialization()
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

/** Run the full chain with the X adapter opted in. */
function fetchThroughChain(url, settings = {}, policy = POLICY) {
  return chainedFetch({ url }, undefined, {
    ...policy,
    maxBytes: 5 * 1024 * 1024,
    // The plugin runs external binaries through the HOST subprocess seam
    // (no node:child_process fallback any more), so the test supplies a
    // seam that really executes the shim.
    ctx: fakeHostContext(),
    settings: { adapters: { x: { enabled: true } }, ...settings },
  })
}

// ── Frozen command surface ───────────────────────────────────────────

test('x: the read and write verb sets are disjoint', () => {
  const read = new Set(x.READ_ONLY_VERBS)
  for (const w of x.WRITE_VERBS) {
    assert.equal(read.has(w), false, `verb "${w}" is both readable and writable`)
  }
  assert.ok(x.WRITE_VERBS.includes('post'))
  assert.ok(x.WRITE_VERBS.includes('delete'))
  assert.ok(x.WRITE_VERBS.includes('follow'))
})

test('x: the timeline verb is a frozen literal, never derived from input', () => {
  assert.equal(x.TIMELINE_VERB, 'tweets')
  assert.deepEqual([...x.READ_ONLY_VERBS], ['tweets'])
})

// Regression guard for a defect the dev-profile e2e actually produced:
// web_fetch carries ToolDefinition.timeoutMs = dsh-tool-web's
// fetchTimeoutMs (default 30000), and dsh-tool-call-timeout-policy turns
// that into a HARD abort. A 120s adapter deadline therefore never
// degraded — the host killed the call first, and the user saw a bare
// "tool call timed out" instead of a degraded public page.
test('x: the default deadline must fit inside the host web_fetch budget', () => {
  const HOST_WEB_FETCH_BUDGET_MS = 30_000 // dsh-tool-web DEFAULT_WEB_TOOL_TIMEOUT_MS
  assert.ok(
    x.DEFAULT_TIMEOUT_MS < HOST_WEB_FETCH_BUDGET_MS,
    `DEFAULT_TIMEOUT_MS (${x.DEFAULT_TIMEOUT_MS}) must leave room inside the host budget (${HOST_WEB_FETCH_BUDGET_MS}) for the degradation fallback`,
  )
  // And it must still be generous against measured healthy latency (5-7s).
  assert.ok(x.DEFAULT_TIMEOUT_MS >= 15_000, 'too tight: a cold opencli would degrade spuriously')
})

test('x: buildArgv puts the subcommand at argv[2] and varies only the bounded limit', () => {
  const a = x.buildArgv({ username: 'karpathy' }, 20)
  const b = x.buildArgv({ username: 'karpathy' }, 50)
  assert.equal(a[2], 'tweets')
  assert.equal(b[2], 'tweets')
  assert.equal(a[3], 'karpathy')
  assert.equal(a[5], '20')
  assert.equal(b[5], '50')
  // Everything except the username and the limit is identical.
  const strip = (v) => { const c = v.slice(); c[3] = 'X'; c[5] = 'X'; return c }
  assert.deepEqual(strip(a), strip(b))
})

// ── URL parsing / canHandle ──────────────────────────────────────────

test('x: canHandle accepts profile URLs across X/Twitter aliases', () => {
  for (const u of [
    'https://x.com/karpathy',
    'https://x.com/karpathy/',
    'https://www.x.com/karpathy',
    'https://mobile.x.com/karpathy',
    'https://twitter.com/karpathy',
    'https://www.twitter.com/karpathy',
    'https://mobile.twitter.com/karpathy',
    'http://x.com/karpathy',
    'https://x.com/@karpathy',
  ]) {
    assert.equal(x.canHandle(u), true, u)
  }
})

test('x: canHandle rejects lookalike hosts and non-X hosts', () => {
  for (const u of [
    'https://x.com.evil.tld/karpathy',
    'https://notx.com/karpathy',
    'https://x.com.co/karpathy',
    'https://evilx.com/karpathy',
    'https://example.com/karpathy',
    'https://github.com/karpathy',
    'jаvascript:alert(1)', // eslint-disable-line
  ]) {
    assert.equal(x.canHandle(u), false, u)
  }
})

test('x: phase A matches ONLY the timeline shape', () => {
  // Single-tweet URLs must keep resolving through the public genericHtml
  // path — taking them over would trade a working capability for an
  // unverified one.
  for (const u of [
    'https://x.com/karpathy/status/2105909609487872075',
    'https://x.com/karpathy/status/2105909609487872075/photo/1',
    'https://x.com/i/lists/123456',
    'https://x.com/karpathy/with_replies',
    'https://x.com/search?q=llm',
    'https://x.com/',
  ]) {
    assert.equal(x.canHandle(u), false, u)
  }
})

test('x: canHandle rejects site routes that are not usernames', () => {
  for (const seg of ['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search', 'bookmarks', 'lists']) {
    assert.equal(x.canHandle(`https://x.com/${seg}`), false, seg)
  }
})

test('x: canHandle rejects credentials, ports and over-long URLs', () => {
  assert.equal(x.canHandle('https://user:pass@x.com/karpathy'), false)
  assert.equal(x.canHandle('https://x.com:8443/karpathy'), false)
  assert.equal(x.canHandle(`https://x.com/${'a'.repeat(3000)}`), false)
})

test('x: parseTarget produces the canonical x.com target regardless of alias', () => {
  for (const u of ['https://twitter.com/karpathy', 'https://mobile.x.com/karpathy', 'https://x.com/@karpathy']) {
    const t = x.parseTarget(u)
    assert.ok(t, u)
    assert.equal(t.username, 'karpathy')
    assert.equal(t.canonicalUrl, 'https://x.com/karpathy')
  }
})

// ── The injection surface ────────────────────────────────────────────

test('x: adversarial URLs cannot reach argv as a subcommand', () => {
  // Two distinct claims, deliberately NOT conflated:
  //   (a) a URL that fails to parse is not handled at all;
  //   (b) a URL that DOES parse may only contribute a bare handle, and
  //       the subcommand stays the frozen literal.
  // `https://x.com/post` is a legitimate profile URL for the handle
  // "@post" — the point is not that it is rejected, but that "post"
  // lands in the USERNAME slot and can never become the subcommand.
  const hostile = [
    'https://x.com/post',
    'https://x.com/delete',
    'https://x.com/follow',
    'https://x.com/tweets',
    'https://x.com/--limit',
    'https://x.com/-f',
    'https://x.com/karpathy;rm -rf /',
    'https://x.com/karpathy%00',
    'https://x.com/..%2f..%2fetc',
    'https://x.com/karpathy/post',
    'https://x.com/%2e%2e',
    'https://x.com/karpathy?x=post',
    'https://x.com/karpathy --limit 999',
  ]
  const mustNotParse = new Set([
    'https://x.com/--limit',
    'https://x.com/-f',
    'https://x.com/karpathy;rm -rf /',
    'https://x.com/karpathy%00',
    'https://x.com/..%2f..%2fetc',
    'https://x.com/karpathy/post',
    'https://x.com/%2e%2e',
    'https://x.com/karpathy --limit 999',
  ])

  for (const u of hostile) {
    const t = x.parseTarget(u)
    if (mustNotParse.has(u)) {
      assert.equal(t, null, `must not parse: ${u}`)
      assert.equal(x.canHandle(u), false, `must not be handled: ${u}`)
      continue
    }
    assert.ok(t, `expected to parse: ${u}`)
    assert.match(t.username, /^[A-Za-z0-9_]{1,15}$/, u)
    const argv = x.buildArgv(t, 20)
    // The load-bearing invariant: argv[2] is the literal, always.
    assert.equal(argv[2], 'tweets', u)
    // And nothing flag-shaped leaked into the username slot.
    assert.equal(argv[3].startsWith('-'), false, u)
  }
})

// ── The consent gate (F2) ────────────────────────────────────────────

test('x: missing or old settings never enable the adapter', () => {
  const url = 'https://x.com/karpathy'
  for (const settings of [
    undefined,
    null,
    {},
    { adapters: {} },
    { adapters: { x: {} } },
    { adapters: { x: { enabled: false } } },
    { adapters: { x: { enabled: 'true' } } },
    { adapters: { x: { enabled: 1 } } },
  ]) {
    const m = matchSpecializedAdapter(url, settings)
    assert.equal(m, null, `must not match for ${JSON.stringify(settings)}`)
  }
})

test('x: a literal enabled === true is the only way in', () => {
  const m = matchSpecializedAdapter('https://x.com/karpathy', { adapters: { x: { enabled: true } } })
  assert.ok(m)
  assert.equal(m.id, 'x')
})

test('x: zero spawns while opt-in is absent', () => {
  const shim = installShim()
  try {
    for (const settings of [undefined, {}, { adapters: {} }, { adapters: { x: {} } }, { adapters: { x: { enabled: false } } }]) {
      assert.equal(matchSpecializedAdapter('https://x.com/karpathy', settings), null)
    }
    assert.equal(shim.argv(), null, 'the opencli binary must never have been invoked')
  } finally {
    shim.restore()
  }
})

// ── Policy must cover the URL opencli actually visits (F6) ───────────

test('x: an allowed alias cannot smuggle a denied canonical host', async () => {
  const shim = installShim()
  try {
    // Policy allows twitter.com and says nothing about x.com, but opencli
    // navigates to x.com. Validating only the request URL would let this
    // through.
    await assert.rejects(
      () => fetchThroughChain('https://twitter.com/karpathy', {}, {
        ssrf: { allowRanges: [], trustEnvProxy: false },
        domainPolicy: { allow: ['twitter.com'], deny: [] },
      }),
      (e) => e && e.code === 'WEB_BLOCKED_URL',
    )
    assert.equal(shim.argv(), null, 'nothing may be spawned when policy rejects the real target')
  } finally {
    shim.restore()
  }
})

test('x: a policy denial is never degraded into a public fetch', async () => {
  let publicCalls = 0
  await assert.rejects(
    () => x.fetch({ url: 'https://twitter.com/karpathy' }, undefined, {
      policy: {
        ssrf: { allowRanges: [], trustEnvProxy: false },
        domainPolicy: { allow: ['twitter.com'], deny: [] },
      },
      settings: { adapters: { x: { enabled: true } } },
      publicFetch: async () => { publicCalls++; return { body: { kind: 'text', content: 'shell' } } },
    }),
    (e) => e && e.code === 'WEB_BLOCKED_URL',
  )
  assert.equal(publicCalls, 0, 'a policy denial must not reach the public path')
})

// ── Full chain, happy path ───────────────────────────────────────────

test('x: the full chain reaches the frozen argv and preserves the auth flag', async () => {
  const shim = installShim()
  try {
    const res = await fetchThroughChain('https://x.com/karpathy')
    const argv = shim.argv()
    assert.deepEqual(argv, [
      'twitter', 'tweets', 'karpathy',
      '--limit', '20',
      '-f', 'json',
      '--site-session', 'ephemeral',
      '--keep-tab', 'false',
      '--window', 'background',
    ])
    assert.equal(res.adapterId, 'x')
    assert.equal(res.authenticated, true, 'browser results must be marked authenticated')
    assert.match(res.body.content, /hello world/)
    assert.match(res.notes, /opencli 1\.8\.8/)
    assert.equal(res.degraded, undefined)
  } finally {
    shim.restore()
  }
})

test('x: the configured limit is honoured and bounded', async () => {
  const shim = installShim()
  try {
    await fetchThroughChain('https://x.com/karpathy', { adapters: { x: { enabled: true, limit: 37 } } })
    const argv = shim.argv()
    assert.equal(argv[argv.indexOf('--limit') + 1], '37')
    assert.equal(x.buildArgv({ username: 'a' }, 9999).length > 0, true)
  } finally {
    shim.restore()
  }
})

// ── Degradation (F3) ─────────────────────────────────────────────────

const SHELL = {
  url: 'https://x.com/karpathy',
  statusCode: 200,
  body: { kind: 'html', content: 'PUBLIC SHELL: bio, follower count', extraction: 'generic-html' },
  contentType: 'text/html',
  adapterId: 'generic-html',
  contentDigest: 'old',
  truncated: false,
}

function degradeCtx(publicFetch) {
  return {
    policy: POLICY,
    settings: { adapters: { x: { enabled: true } } },
    publicFetch,
    // The adapter reaches the external binary through the HOST subprocess
    // seam; `ctx.ctx` is the plugin context the seam lives on.
    ctx: fakeHostContext(),
  }
}

test('x: a missing binary degrades to the public page with a visible notice', async () => {
  // PATH is emptied so the spawn really does fail with ENOENT — the
  // gradient between "backend is down" and "backend is up" must not be
  // decided by whether this machine happens to have opencli installed.
  const noPath = installEmptyPath()
  try {
    let calls = 0
    const res = await x.fetch({ url: 'https://x.com/karpathy' }, undefined, degradeCtx(async () => {
      calls++
      return { ...SHELL, body: { ...SHELL.body } }
    }))
    assert.equal(calls, 1)
    assert.equal(res.degraded, true)
    assert.equal(res.authenticated, false, 'a degraded public page is NOT authenticated content')
    assert.equal(res.adapterId, 'x-degraded')
    // The notice must be IN THE BODY: a caller that only renders content
    // must still learn that the timeline was not retrieved.
    assert.match(res.body.content, /Timeline not retrieved/)
    assert.match(res.body.content, /BINARY_MISSING/)
    assert.match(res.body.content, /PUBLIC SHELL/)
    assert.match(res.notes, /degraded/)
    assert.notEqual(res.contentDigest, SHELL.contentDigest, 'digest must match the final body')
  } finally {
    noPath.restore()
  }
})

test('x: without a publicFetch callback the backend failure propagates', async () => {
  const noPath = installEmptyPath()
  try {
    await assert.rejects(
      () => x.fetch({ url: 'https://x.com/karpathy' }, undefined, {
        policy: POLICY,
        settings: { adapters: { x: { enabled: true } } },
        ctx: fakeHostContext(),
      }),
      (e) => e && e.code === 'WEB_FETCH_FAILED',
    )
  } finally {
    noPath.restore()
  }
})

test('x: a failing public fetch reports the ORIGINAL backend error', async () => {
  const noPath = installEmptyPath()
  try {
    await assert.rejects(
      () => x.fetch({ url: 'https://x.com/karpathy' }, undefined, degradeCtx(async () => {
        throw new Error('public path also down')
      })),
      (e) => e && e.code === 'WEB_FETCH_FAILED' && /ENOENT|opencli/.test(String(e.message)),
    )
  } finally {
    noPath.restore()
  }
})

test('x: an aborted signal never degrades', async () => {
  const noPath = installEmptyPath()
  try {
    let calls = 0
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => x.fetch({ url: 'https://x.com/karpathy' }, ac.signal, degradeCtx(async () => {
        calls++
        return { ...SHELL }
      })),
      (e) => e && (e.class === 'aborted' || e.name === 'AbortError' || e.code === 'ABORTED'),
    )
    assert.equal(calls, 0, 'an abort must not be re-routed into an HTTP request')
  } finally {
    noPath.restore()
  }
})

// ── Output classification (F5/F7) ────────────────────────────────────

test('x: parseTweetRows accepts a bare array and a wrapped envelope', () => {
  const rows = [{ id: '1', text: 'hi' }]
  assert.deepEqual(x.parseTweetRows(JSON.stringify(rows)).rows, rows)
  assert.deepEqual(x.parseTweetRows(JSON.stringify({ data: rows })).rows, rows)
  assert.deepEqual(x.parseTweetRows(JSON.stringify({ tweets: rows })).rows, rows)
})

test('x: an empty array is a legitimate result, not an error', () => {
  const r = x.parseTweetRows('[]')
  assert.equal(r.ok, true)
  assert.deepEqual(r.rows, [])
})

test('x: broken payloads never become a successful empty list', () => {
  for (const bad of ['', '   ', 'null', '{', '{"totally":"different"}', 'not json at all', '{"ok":false,"error":{"code":"TIMEOUT"}}']) {
    const r = x.parseTweetRows(bad)
    assert.equal(r.ok, false, `must reject: ${JSON.stringify(bad)}`)
  }
})

test('x: rows without an id or text are rejected rather than silently dropped', () => {
  const r = x.parseTweetRows(JSON.stringify([{ unrelated: 1 }, { unrelated: 2 }]))
  assert.equal(r.ok, false)
})

test('x: a non-zero exit degrades instead of returning an empty timeline', async () => {
  const shim = installShim({ stdout: 'boom', exitCode: 1 })
  try {
    let publicCalls = 0
    const res = await x.fetch({ url: 'https://x.com/karpathy' }, undefined, degradeCtx(async () => {
      publicCalls++
      return { ...SHELL, body: { ...SHELL.body } }
    }))
    assert.equal(publicCalls, 1)
    assert.equal(res.degraded, true)
    assert.match(res.body.content, /Timeline not retrieved/)
  } finally {
    shim.restore()
  }
})

test('x: an auth failure is classified as NOT_AUTHENTICATED and degrades', async () => {
  const shim = installShim({ stdout: 'error: not logged in', exitCode: 1 })
  try {
    const res = await x.fetch({ url: 'https://x.com/karpathy' }, undefined, degradeCtx(async () => ({
      ...SHELL, body: { ...SHELL.body },
    })))
    assert.equal(res.degraded, true)
    assert.match(res.body.content, /NOT_AUTHENTICATED/)
  } finally {
    shim.restore()
  }
})

// ── Drift against the installed opencli (F4) ─────────────────────────
//
// This is a COMPATIBILITY check, not a behaviour proof: an override or a
// rewritten implementation can still report `Access: read` while doing
// something else. It catches the cheap failure — a verb that becomes a
// write in a later opencli release.

test('x: the frozen read set agrees with the installed opencli taxonomy', async (t) => {
  const shimmed = process.env.PATH || ''
  void shimmed
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync('opencli', ['twitter', '--help'], { encoding: 'utf8', timeout: 15000 })
  if (probe.error || probe.status !== 0 || !probe.stdout) {
    t.skip('opencli is not available on this machine')
    return
  }
  const out = probe.stdout
  for (const verb of x.READ_ONLY_VERBS) {
    const re = new RegExp(`^\\s+${verb}\\b.*?\\[read\\]`, 'm')
    assert.match(out, re, `opencli no longer marks "${verb}" as [read]`)
  }
  for (const verb of x.WRITE_VERBS) {
    const re = new RegExp(`^\\s+${verb}\\b.*?\\[write\\]`, 'm')
    assert.match(out, re, `opencli no longer marks "${verb}" as [write]`)
  }
})
