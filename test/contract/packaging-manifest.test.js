// Packaging and display-metadata contract for the dsh-trinity bundle.
//
// The DSH host reads plugin display metadata without activating the plugin:
// `readPluginMeta()` resolves `<specifier>/locale/en.json`,
// `<specifier>/package.json` and `<specifier>/icon` through the package
// `exports` map, and falls back to the manifest `name`/`description` when the
// locale fields are missing. `evaluatePluginCompatibility()` decides
// compatibility from `engines.dsh` with semver prerelease semantics.
//
// These tests pin that contract offline: no network, no host runtime, and no
// new dependency (this repository ships no semver package).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ICON_LIMIT_BYTES = 256 * 1024

// ── semver floor:start ──
// The Host decides compatibility with
// `semver.satisfies(runtimeVersion, engines.dsh, { includePrerelease: true })`
// (dsh-app-boot/lib/index.js). This plugin declares ONE range shape — a
// `>=` comparator with a `-0` prerelease floor — so these checks spell out
// that single rule instead of re-implementing semver inside the test (a
// hand-rolled semver would only prove that the hand-rolled semver agrees
// with itself).
//
// The `-0` floor is load-bearing: with `includePrerelease`, a prerelease
// sorts BELOW its own release, so `>=0.1.7` would REJECT `0.1.7-alpha.1`
// while `>=0.1.7-0` accepts it. The samples below were cross-checked
// against the semver build the DSH host ships (semver 7.8.5).
function parseVersion (raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(raw).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease (left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1   // a release outranks its prereleases
  if (right.length === 0) return -1
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const na = /^\d+$/.test(a)
    const nb = /^\d+$/.test(b)
    if (na && nb) {
      const diff = Number(a) - Number(b)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (na !== nb) {
      return na ? -1 : 1   // numeric identifiers sort below alphanumeric ones
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

function compareVersions (left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Does `version` satisfy a `>=<floor>` range whose floor carries a `-0`
 * prerelease tag (the shape this plugin declares)?
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
function satisfiesFloor (version, range) {
  const match = /^>=\s*v?(\d+)\.(\d+)\.(\d+)-0$/.exec(String(range).trim())
  if (!match) return false
  const floor = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // The `-0` floor IS a prerelease: the lowest one of that version.
    prerelease: ['0'],
  }
  const candidate = parseVersion(version)
  if (!candidate) return false
  return compareVersions(candidate, floor) >= 0
}
// ── semver floor:end ──

// Minimal XML well-formedness scan: enough to reject a malformed icon without
// adding a parser dependency.
function checkXmlWellFormed (source) {
  const stack = []
  let rootSeen = false
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) break
    const text = source.slice(index, open)
    const badEntity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(text)
    if (badEntity !== null) return `unterminated entity near "${badEntity[0]}"`
    index = open
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      if (end === -1) return 'unterminated comment'
      index = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9)
      if (end === -1) return 'unterminated CDATA section'
      index = end + 3
      continue
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2)
      if (end === -1) return 'unterminated processing instruction'
      index = end + 2
      continue
    }
    if (source.startsWith('<!', index)) {
      let depth = 0
      let cursor = index
      for (; cursor < source.length; cursor++) {
        const character = source[cursor]
        if (character === '[') depth++
        else if (character === ']') depth--
        else if (character === '>' && depth === 0) break
      }
      if (cursor >= source.length) return 'unterminated declaration'
      index = cursor + 1
      continue
    }
    const close = source.indexOf('>', index)
    if (close === -1) return 'unterminated tag'
    const raw = source.slice(index + 1, close)
    index = close + 1
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim()
      if (name === '') return 'empty closing tag'
      if (stack.length === 0) return `closing tag </${name}> without an open element`
      const open2 = stack.pop()
      if (open2 !== name) return `closing tag </${name}> does not match <${open2}>`
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const name = body.split(/\s/)[0]
    if (name === '') return 'tag without a name'
    const unquoted = /=\s*(?!["'])[^\s>]+/.exec(body.slice(name.length))
    if (unquoted !== null) return `unquoted attribute value in <${name}>`
    if (stack.length === 0) {
      if (rootSeen) return 'more than one root element'
      rootSeen = true
      if (name !== 'svg') return `root element is <${name}>, expected <svg>`
    }
    if (!selfClosing) stack.push(name)
  }
  if (stack.length > 0) return `unclosed element <${stack[stack.length - 1]}>`
  if (!rootSeen) return 'no root element'
  return null
}

test('the manifest exports the display resources the host resolves', () => {
  const exportsMap = PACKAGE.exports
  assert.equal(typeof exportsMap, 'object')
  assert.equal(exportsMap['.'], './lib/index.js')
  assert.equal(exportsMap['./client'], './lib/client.js')
  assert.equal(exportsMap['./locale/*.json'], './locale/*.json')
  assert.equal(exportsMap['./icon'], './icon.svg')
  assert.equal(exportsMap['./package.json'], './package.json',
    'the host reads the manifest through the exports map for its name/description fallback')
})

test('every exported display subpath resolves to a file inside the package', () => {
  const resolved = {
    'package.json': import.meta.resolve('dsh-trinity/package.json'),
    icon: import.meta.resolve('dsh-trinity/icon'),
    'locale/en.json': import.meta.resolve('dsh-trinity/locale/en.json'),
    'locale/zh.json': import.meta.resolve('dsh-trinity/locale/zh.json'),
  }
  for (const [label, target] of Object.entries(resolved)) {
    assert.ok(target.startsWith('file://'), `${label} resolves to a file URL`)
    assert.ok(target.startsWith(`file://${REPO_ROOT}`), `${label} resolves inside the package`)
    assert.ok(statSync(fileURLToPath(target)).isFile(), `${label} exists on disk`)
  }
})

test('the packed file list keeps every exported display asset', () => {
  const files = PACKAGE.files
  assert.ok(Array.isArray(files))
  assert.ok(files.includes('locale/*.json'), 'locale dictionaries ship with the package')
  assert.ok(files.includes('icon.svg'), 'the icon ships with the package')
  assert.ok(files.includes('lib'))
  assert.ok(files.includes('!lib/_deferred'))
  assert.ok(files.includes('cordis.patch.yml'))
})

test('engines.dsh declares the supported DSH versions', () => {
  const range = PACKAGE.engines?.dsh
  assert.equal(typeof range, 'string')
  // Pinned literally: the range is the Host's install-time gate, so a
  // silent change to it must be a deliberate, visible edit.
  assert.equal(range, '>=0.1.7-0',
    'engines.dsh must stay ">=0.1.7-0" — the -0 floor keeps 0.1.7 prereleases inside the range')
  assert.equal(satisfiesFloor('0.2.1-rc.5', range), true,
    'the current DSH runtime satisfies the range')
  assert.equal(satisfiesFloor('0.2.0-rc.2', range), true)
  assert.equal(satisfiesFloor('0.1.7-rc.1', range), true)
  assert.equal(satisfiesFloor('0.1.7-alpha.1', range), true,
    'prereleases of the lowest supported version stay inside the range')
  assert.equal(satisfiesFloor('0.1.7', range), true)
  assert.equal(satisfiesFloor('0.1.6-alpha.1', range), false)
  assert.equal(satisfiesFloor('0.1.6', range), false)
})

test('engines.node keeps the runtime floor and the dependency set stays minimal', () => {
  assert.equal(PACKAGE.engines.node, '>=22')
  assert.equal('p-limit' in PACKAGE.dependencies, false, 'p-limit is unused and must not ship')
  assert.equal(PACKAGE.dependencies['@deepseek-ai/schemastery'], '^3.18.3')
})

test('every shipped locale provides non-empty display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const dictionary = JSON.parse(readFileSync(new URL(`../../locale/${locale}.json`, import.meta.url), 'utf8'))
    assert.equal(typeof dictionary.meta, 'object')
    assert.equal(typeof dictionary.meta.title, 'string', `${locale} meta.title is a string`)
    assert.equal(typeof dictionary.meta.description, 'string', `${locale} meta.description is a string`)
    assert.ok(dictionary.meta.title.trim().length > 0, `${locale} meta.title is not empty`)
    assert.ok(dictionary.meta.description.trim().length > 0, `${locale} meta.description is not empty`)
  }
})

test('the icon is a self-contained SVG within the size limit', () => {
  const iconPath = new URL('../../icon.svg', import.meta.url)
  const stats = statSync(iconPath)
  assert.ok(stats.size <= ICON_LIMIT_BYTES, `icon.svg is ${stats.size} bytes, limit is ${ICON_LIMIT_BYTES}`)
  const source = readFileSync(iconPath, 'utf8')
  const problem = checkXmlWellFormed(source)
  assert.equal(problem, null, `icon.svg must be well-formed XML: ${problem}`)
  assert.ok(source.includes('<svg'), 'icon.svg has an <svg> root element')
  assert.equal(/<(image|foreignObject|text|script|style)\b/.test(source), false,
    'the icon stays pure vector without embedded fonts or raster content')
  const externalReference = /(?:href|xlink:href)\s*=\s*["'](?!#)([^"']+)["']/.exec(source)
  assert.equal(externalReference, null, 'the icon references no external resource')
  const externalPaint = /url\((?!#)([^)]+)\)/.exec(source)
  assert.equal(externalPaint, null, 'the icon paints from no external resource')
})
