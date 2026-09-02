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
  // The disabled-bundle id "web-search-deepseek" is allowed (the patch
  // explicitly disables it); but no line should ENABLE it or route
  // ctx.web.searchProvider / ctx.web.fetchProvider to anything deepseek.
  const lines = PATCH.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue // comment
    if (/^-\s*id:\s*web-search-deepseek\s*$/.test(trimmed)) {
      let next = lines.slice(i + 1).find((l) => l.trim().length > 0 && !l.trim().startsWith('#'))
      if (next && /^disabled:\s*true\s*$/.test(next.trim())) continue
      assert.fail('web-search-deepseek row must be followed by `disabled: true`')
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

// Alpha 4: dsh-web-app@0.1.2-alpha.5 ships a `tool-web: disabled: true`
// override in its own cordis.patch.yml. Without the plugin re-enabling
// it, any alpha.4 profile that mounts dsh-web-app loses the model-facing
// web_search / web_fetch tool. The plugin must undo the disable. The
// alpha.4 base default already supplies `config.fetch: true` (card
// A4-06), so the plugin must NOT restate it.

test('Alpha 4: cordis.patch.yml re-enables tool-web (dsh-web-app disables it)', () => {
  // The tool-web row must be a single two-line `id: tool-web / disabled: false`
  // block; no `config:` sub-key, no `config.fetch`, no other fields.
  const block = PATCH.match(/^- id:\s*tool-web\s*\n([\s\S]*?)(?=^- |\Z)/m)
  assert.ok(block, 'cordis.patch.yml must contain a `- id: tool-web` block')
  const body = block[1]
  // trim leading whitespace per line, drop blanks
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  assert.deepEqual(lines, ['disabled: false'],
    `tool-web row must be exactly: disabled: false (got ${JSON.stringify(lines)})`)
})

test('Alpha 4: cordis.patch.yml does NOT restate tool-web.config.fetch (base default already true)', () => {
  // The plugin must not write `config.fetch: true` on the tool-web row;
  // dsh-base alpha.4 already supplies it. A duplicate would be harmless
  // but is rejected to keep the patch minimal and forward-clean.
  // Scan for any `fetch:` field nested under tool-web; the only place the
  // plugin writes `fetch:` is in the web row's searchProvider / fetchProvider
  // pair, which is allowed and unchanged.
  const toolWebBlock = PATCH.match(/^- id:\s*tool-web\s*\n([\s\S]*?)(?=^- |\Z)/m)
  assert.ok(toolWebBlock, 'cordis.patch.yml must contain a `- id: tool-web` block')
  assert.equal(/fetch:/.test(toolWebBlock[1]), false,
    'tool-web row must not declare `config.fetch: true` — alpha.4 base default covers it')
})
