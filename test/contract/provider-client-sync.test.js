// test/contract/provider-client-sync.test.js — regression lock that the
// BEGIN/END generated block in lib/client.js matches provider-metadata
// after every code change.
//
//   pnpm test                  runs this
//   pnpm run check:provider-client-sync --check
//                              runs the same check in CI
//
// The previous release exposed a silent drift: the check script was
// a placeholder that exited 0 even when the block had no markers. This
// test exercises the real producer (`scripts/sync-provider-client.mjs`)
// via its --check mode so a regression in either the script OR the
// metadata OR the client.js block surfaces as a red test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SYNC = path.join(ROOT, 'scripts', 'sync-provider-client.mjs')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
const BEGIN = '// BEGIN GENERATED TRINITY PROVIDERS'
const END = '// END GENERATED TRINITY PROVIDERS'

test('CC23-R4: client.js BEGIN/END block exists and parses', () => {
  const src = readFileSync(CLIENT, 'utf8')
  const begin = src.indexOf(BEGIN)
  const end = src.indexOf(END)
  assert.ok(begin >= 0, 'BEGIN marker present')
  assert.ok(end > begin, 'END marker present and after BEGIN')
  const inner = src.slice(begin + BEGIN.length, end)
  // Each generated entry carries both the routing classification and the
  // credential-editor facts needed by the 0.1.7 Plugins control center.
  const rows = [...inner.matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*env:\s*"([^"]*)",\s*mode:\s*"([^"]+)",\s*autoEligible:\s*(true|false),\s*showInCredentialUi:\s*(true|false)\s*\}/g)]
  assert.ok(rows.length >= 26, `expected the complete routing inventory, got ${rows.length}`)
  for (const [, id, label, env, mode] of rows) {
    assert.match(id, /^[a-zA-Z][a-zA-Z0-9]*$/, `provider id "${id}" matches slug pattern`)
    assert.ok(label.trim().length > 0, `provider "${id}" has a human display label`)
    assert.ok(['api-key', 'host', 'none'].includes(mode), `provider "${id}" has a supported credential mode`)
    if (mode === 'none') assert.equal(env, '', `keyless provider "${id}" has no credential ref`)
    else assert.match(env, /^[A-Z_][A-Z0-9_]*$/, `provider "${id}" has a POSIX credential ref`)
  }
  assert.ok(rows.some((row) => row[1] === 'duckduckgo' && row[4] === 'none' && row[6] === 'false'),
    'keyless DuckDuckGo stays in the routing view but out of the credential editor')
})

test('CC23-R4b: openai is NOT in client.js (Hosted Search half-impl removed)', () => {
  const src = readFileSync(CLIENT, 'utf8')
  // The only acceptable mention is in a comment explaining the removal.
  // Strip comments and re-check.
  const stripped = src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
  assert.equal(/openai/.test(stripped), false,
    'openai must not appear in any non-comment line of lib/client.js after v2.3.0')
})

test('CC23-R4c: firecrawl + parallelMcp env are the canonical names (no legacy aliases in user-facing UI)', () => {
  const src = readFileSync(CLIENT, 'utf8')
  assert.match(src, /id: "firecrawl", label: "Firecrawl", env: "FIRECRAWL_API_KEY"/,
    'firecrawl must point at the canonical FIRECRAWL_API_KEY, not the legacy FIRECRAWL_KEY alias')
  assert.match(src, /id: "parallelMcp", label: "Parallel MCP", env: "PARALLEL_MCP_API_KEY"/,
    'parallelMcp must point at the canonical PARALLEL_MCP_API_KEY, not the legacy alias')
  // Legacy aliases are non-fatal elsewhere (resolve.js still honours them
  // at pool-resolve time) but must not be the UI-written name.
  assert.equal(/id: "firecrawl"[^\n]+env: "FIRECRAWL_KEY"/.test(src), false)
  assert.equal(/id: "parallelMcp"[^\n]+env: "PARALLELMCP_API_KEY"/.test(src), false)
})

test('CC23-R4d: scripts/sync-provider-client.mjs --check exits 0 against the current tree', () => {
  // Drive the producer in --check mode. If the BEGIN/END block drifted
  // (someone hand-edited client.js, or the metadata changed), this
  // test fails and the CI gate (`pnpm run check:provider-client-sync
  // --check`) fails with the same exit code.
  let result
  try {
    result = execFileSync('node', [SYNC, '--check'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (err && err.stdout) process.stdout.write(err.stdout.toString())
    if (err && err.stderr) process.stderr.write(err.stderr.toString())
    throw new Error(`sync --check exited non-zero: drift between lib/client.js and lib/providers/provider-metadata.js`)
  }
  const out = result.toString().trim()
  assert.match(out, /OK/, 'sync reports OK against current tree')
})
