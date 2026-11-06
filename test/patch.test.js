// test/patch.test.js — cordis.patch.yml validation for v2.0
// (SPEC §II.9: namespaced Provider IDs; no alias for `chained`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('cordis.patch.yml pins web.searchProvider to web-access-chain-search', () => {
  assert.match(PATCH, /searchProvider:\s*web-access-chain-search/)
})

test('cordis.patch.yml pins web.fetchProvider to web-access-chain-fetch', () => {
  assert.match(PATCH, /fetchProvider:\s*web-access-chain-fetch/)
})

test('cordis.patch.yml disables web-search-deepseek bundle', () => {
  assert.match(PATCH, /id:\s*web-search-deepseek[\s\S]+disabled:\s+true/)
})

test('cordis.patch.yml inserts the v2.0 bundle row', () => {
  assert.match(PATCH, /- insert:/)
  assert.match(PATCH, /id:\s*web-access-chain/)
  assert.match(PATCH, /name:\s*dsh-trinity/)
})

test('cordis.patch.yml declares runtime budgets (SPEC §I.9)', () => {
  assert.match(PATCH, /searchTotalTimeoutMs:\s*30000/)
  assert.match(PATCH, /perProviderTimeoutMs:\s*8000/)
  assert.match(PATCH, /perKeyTimeoutMs:\s*8000/)
  assert.match(PATCH, /maxProvidersPerSearch:\s*18/)
  assert.match(PATCH, /maxKeysPerProvider:\s*3/)
  assert.match(PATCH, /aggregateMaxFanout:\s*4/)
})

test('cordis.patch.yml declares cache config (SPEC §II.3.4)', () => {
  assert.match(PATCH, /cacheTtlMs:\s*3600000/)
  assert.match(PATCH, /cacheMaxEntries:\s*128/)
  assert.match(PATCH, /cacheMaxBytes:\s*134217728/)
})

test('cordis.patch.yml declares adapter + tool gates (SPEC §II.4)', () => {
  // Adapter gates (default ON for cheap variants)
  assert.match(PATCH, /github:\s*\{\s*enabled:\s*true\s*\}/)
  assert.match(PATCH, /youtube:\s*\{\s*enabled:\s*true\s*\}/)
  assert.match(PATCH, /pdf:\s*\{\s*enabled:\s*true\s*\}/)
  assert.match(PATCH, /genericHtml:\s*\{\s*enabled:\s*true\s*\}/)
  // Tool gates (default OFF for specialised Tools)
  assert.match(PATCH, /githubPrIssue:\s*\{\s*enabled:\s*false/)
  assert.match(PATCH, /videoExtract:\s*\{\s*enabled:\s*false/)
  assert.match(PATCH, /pdfExtract:\s*\{\s*enabled:\s*false/)
})

test('cordis.patch.yml does NOT route through DeepSeek provider', () => {
  // The shipped DeepSeek rows may only appear as DISABLED rows (the patch
  // switches them off); no line should ENABLE one or route
  // ctx.web.searchProvider / ctx.web.fetchProvider to anything deepseek.
  const lines = PATCH.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue // comment
    if (/^-\s*id:\s*web-(search-)?deepseek(-api)?\s*$/.test(trimmed)) {
      let next = lines.slice(i + 1).find((l) => l.trim().length > 0 && !l.trim().startsWith('#'))
      if (next && /^disabled:\s*true\s*$/.test(next.trim())) continue
      assert.fail(`${trimmed} row must be followed by \`disabled: true\``)
    }
    if (/disabled:\s*true/.test(trimmed)) continue
    if (/searchprovider|fetchprovider/.test(trimmed)) {
      assert.equal(/deepseek/i.test(trimmed), false, trimmed)
    }
    if (/deepseek/i.test(trimmed)) {
      assert.fail('cordis.patch.yml should not actively mention deepseek: ' + trimmed)
    }
  }
})

test('cordis.patch.yml does NOT include retired v1.0 tool flags', () => {
  // Tools retired in v2.0 (SPEC §I.5 / §III.3)
  for (const retired of [
    'page_extract', 'gemini_search', 'gemini_url_context',
    'youtube_extract', 'video_extract', 'github_extract',
    'web_fetch_ex',
  ]) {
    assert.equal(
      new RegExp(`^\\s*${retired}:`, 'm').test(PATCH),
      false,
      `cordis.patch.yml should not declare retired tool: ${retired}`,
    )
  }
})

test('cordis.patch.yml contains mmxFallback + ssrf config', () => {
  assert.match(PATCH, /mmxFallback:\s*true/)
  assert.match(PATCH, /trustEnvProxy:\s*false/)
})

test('cordis.patch.yml contains sourceCheck config (SPEC §II.5)', () => {
  assert.match(PATCH, /sourceCheck:/)
  assert.match(PATCH, /subQueryCount:\s*3/)
  assert.match(PATCH, /maxPagesFetch:\s*5/)
  assert.match(PATCH, /topPassagesPerSource:\s*3/)
})

test('cordis.patch.yml does NOT contain legacyImport markers (v2.1 removed legacy-import)', () => {
  // Strip the comment block before scanning — explanatory comments that
  // mention removed fields (e.g. "removed in v2.1") are fine; the
  // assertion is about OPERATIONAL content (config keys, code paths).
  const code = PATCH.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  assert.equal(/legacyImportVersion:/.test(code), false,
    'cordis.patch.yml must not declare legacyImportVersion (removed in v2.1)')
  assert.equal(/legacyImportConflicts:/.test(code), false,
    'cordis.patch.yml must not declare legacyImportConflicts (removed in v2.1)')
  assert.equal(/legacy-?import/i.test(code), false,
    'cordis.patch.yml operational content must not reference the removed legacy-import subsystem')
})

// DSH 0.2.1 (rc.1+): the Host composes the model-facing web tools PER AGENT
// PRESET — `dsh-web-app/presets/{standard,ptc}.patch.yml` insert a
// `tool-web` row, `minimal` does not — and keeps the Host-level row
// disabled. Older releases of this bundle overrode that row with
// `disabled: false`, which (a) handed the web tools to presets that
// intentionally exclude them and (b) silently became a no-op whenever
// this bundle was not layered AFTER `dsh-web-app`.
//
// Since 2.4.3 the bundle does NOT touch the `tool-web` row at all: the
// standard/ptc presets still expose `web_search` / `web_fetch`, and those
// tools reach this bundle through the pinned `ctx.web` providers.

test('DSH 0.2.1: cordis.patch.yml does NOT override the host tool-web row', () => {
  const block = PATCH.match(/^-\s*id:\s*tool-web\s*$/m)
  assert.equal(block, null,
    'the bundle must not touch `tool-web` — the host composes web tools per agent preset')
})

test('DSH 0.2.1: cordis.patch.yml disables the shipped web-deepseek-api row', () => {
  const lines = PATCH.split('\n')
  const idx = lines.findIndex((l) => /^-\s*id:\s*web-deepseek-api\s*$/.test(l.trim()))
  assert.ok(idx >= 0, 'cordis.patch.yml must contain a `- id: web-deepseek-api` row')
  const next = lines.slice(idx + 1).find((l) => l.trim().length > 0 && !l.trim().startsWith('#'))
  assert.ok(next && /^disabled:\s*true\s*$/.test(next.trim()),
    'web-deepseek-api row must be followed by `disabled: true`')
})
