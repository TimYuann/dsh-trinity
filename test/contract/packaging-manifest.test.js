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

// ── semver-lite:start ──
// Minimal semver range support. The semantics mirror semver 7.x for the
// comparator forms used by `engines.dsh` (>=, <=, >, <, =, ^, ~, partial
// versions, x-ranges, whitespace-joined sets, `||` alternatives and hyphen
// ranges) and were differentially checked against the semver version the DSH
// host ships.
const WILDCARDS = new Set(['x', 'X', '*'])

function isWildcard (value) {
  return value === undefined || WILDCARDS.has(value)
}

function at (major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease }
}

function parseVersion (raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(raw).trim())
  if (match === null) throw new Error(`invalid semantic version: ${raw}`)
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  for (const identifier of prerelease) {
    if (identifier === '') throw new Error(`invalid prerelease identifier in ${raw}`)
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`invalid numeric prerelease identifier in ${raw}`)
    }
  }
  return at(Number(match[1]), Number(match[2]), Number(match[3]), prerelease)
}

function compareIdentifiers (left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const difference = Number(left) - Number(right)
    return difference === 0 ? 0 : (difference < 0 ? -1 : 1)
  }
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left === right ? 0 : (left < right ? -1 : 1)
}

function comparePrerelease (left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const difference = compareIdentifiers(left[index], right[index])
    if (difference !== 0) return difference
  }
  return 0
}

function compareVersions (left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

const COMPARATOR_PATTERN = /^(\^|~>?|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function anyComparator () {
  // semver models `*` and `>=0.0.0` as one comparator that matches every
  // version but carries no prerelease, so prereleases stay excluded from it
  // unless the caller opts into them.
  return { operator: 'any', version: at(0, 0, 0) }
}

function expandComparator (token, includePrerelease) {
  const match = COMPARATOR_PATTERN.exec(token)
  if (match === null) throw new Error(`invalid comparator: ${token}`)
  const operator = match[1] === undefined ? '' : match[1]
  const major = isWildcard(match[2]) ? null : Number(match[2])
  const minor = isWildcard(match[3]) ? null : Number(match[3])
  const patch = isWildcard(match[4]) ? null : Number(match[4])
  const prerelease = match[5] === undefined ? [] : match[5].split('.')
  // `-0` is the lowest possible prerelease; semver adds it to the lower
  // bound of x-ranges, carets and tildes when prereleases participate.
  const zero = includePrerelease ? ['0'] : []

  if (major === null) {
    if (operator === '>' || operator === '<') return [{ operator: '<', version: at(0, 0, 0, ['0']) }]
    return [anyComparator()]
  }
  if (minor === null && patch !== null) throw new Error(`invalid comparator: ${token}`)

  if (operator === '^') {
    if (minor === null) {
      return [{ operator: '>=', version: at(major, 0, 0, zero) }, { operator: '<', version: at(major + 1, 0, 0, ['0']) }]
    }
    if (patch === null) {
      const upper = major === 0 ? at(0, minor + 1, 0, ['0']) : at(major + 1, 0, 0, ['0'])
      return [{ operator: '>=', version: at(major, minor, 0, zero) }, { operator: '<', version: upper }]
    }
    if (major === 0 && minor === 0) {
      return [{ operator: '>=', version: at(0, 0, patch, prerelease) }, { operator: '<', version: at(0, 0, patch + 1, ['0']) }]
    }
    if (major === 0) {
      return [{ operator: '>=', version: at(0, minor, patch, prerelease) }, { operator: '<', version: at(0, minor + 1, 0, ['0']) }]
    }
    return [{ operator: '>=', version: at(major, minor, patch, prerelease) }, { operator: '<', version: at(major + 1, 0, 0, ['0']) }]
  }

  if (operator === '~' || operator === '~>') {
    if (minor === null) {
      return [{ operator: '>=', version: at(major, 0, 0, zero) }, { operator: '<', version: at(major + 1, 0, 0, ['0']) }]
    }
    if (patch === null) {
      return [{ operator: '>=', version: at(major, minor, 0, zero) }, { operator: '<', version: at(major, minor + 1, 0, ['0']) }]
    }
    return [{ operator: '>=', version: at(major, minor, patch, prerelease) }, { operator: '<', version: at(major, minor + 1, 0, ['0']) }]
  }

  if (minor === null || patch === null) {
    // x-range forms: `1`, `1.2`, `1.x`, `1.2.x`
    const xm = minor === null
    const lower = at(major, xm ? 0 : minor, 0, zero)
    if (operator === '>') {
      return [{ operator: '>=', version: xm ? at(major + 1, 0, 0, zero) : at(major, minor + 1, 0, zero) }]
    }
    if (operator === '<=') {
      return [{ operator: '<', version: xm ? at(major + 1, 0, 0, ['0']) : at(major, minor + 1, 0, ['0']) }]
    }
    if (operator === '<') {
      return [{ operator: '<', version: at(major, xm ? 0 : minor, 0, ['0']) }]
    }
    if (operator === '>=') {
      return [{ operator: '>=', version: lower }]
    }
    const upper = xm ? at(major + 1, 0, 0, ['0']) : at(major, minor + 1, 0, ['0'])
    return [{ operator: '>=', version: lower }, { operator: '<', version: upper }]
  }

  const exact = at(major, minor, patch, prerelease)
  switch (operator) {
    case '>': return [{ operator: '>', version: exact }]
    case '>=': return [{ operator: '>=', version: exact }]
    case '<': return [{ operator: '<', version: exact }]
    case '<=': return [{ operator: '<=', version: exact }]
    default: return [{ operator: '=', version: exact }]
  }
}

function expandHyphenRange (from, to, includePrerelease) {
  const parse = (text) => {
    const match = COMPARATOR_PATTERN.exec(text)
    if (match === null) throw new Error(`invalid range boundary: ${text}`)
    return {
      major: isWildcard(match[2]) ? null : Number(match[2]),
      minor: isWildcard(match[3]) ? null : Number(match[3]),
      patch: isWildcard(match[4]) ? null : Number(match[4]),
      prerelease: match[5] === undefined ? [] : match[5].split('.'),
    }
  }
  const start = parse(from)
  const end = parse(to)
  const zero = includePrerelease ? ['0'] : []
  const comparators = []
  if (start.major !== null) {
    if (start.minor === null) comparators.push({ operator: '>=', version: at(start.major, 0, 0, zero) })
    else if (start.patch === null) comparators.push({ operator: '>=', version: at(start.major, start.minor, 0, zero) })
    else comparators.push({ operator: '>=', version: at(start.major, start.minor, start.patch, start.prerelease.length > 0 ? start.prerelease : zero) })
  }
  if (end.major !== null) {
    if (end.minor === null) comparators.push({ operator: '<', version: at(end.major + 1, 0, 0, ['0']) })
    else if (end.patch === null) comparators.push({ operator: '<', version: at(end.major, end.minor + 1, 0, ['0']) })
    else if (end.prerelease.length > 0) comparators.push({ operator: '<=', version: at(end.major, end.minor, end.patch, end.prerelease) })
    else if (includePrerelease) comparators.push({ operator: '<', version: at(end.major, end.minor, end.patch + 1, ['0']) })
    else comparators.push({ operator: '<=', version: at(end.major, end.minor, end.patch) })
  }
  return comparators
}

function parseRange (raw, includePrerelease = false) {
  const text = String(raw).trim()
  if (text === '') throw new Error('empty semver range')
  const alternatives = text.split('||').map((part) => {
    const trimmed = part.trim()
    if (trimmed === '' || trimmed === '*') return [anyComparator()]
    const hyphen = /^(.+?)\s+-\s+(.+)$/.exec(trimmed)
    if (hyphen !== null) return expandHyphenRange(hyphen[1], hyphen[2], includePrerelease)
    const comparators = []
    for (const token of trimmed.split(/\s+/)) {
      if (token === '*' || token === 'x' || token === 'X') continue
      comparators.push(...expandComparator(token, includePrerelease))
    }
    return comparators.length === 0 ? [anyComparator()] : comparators
  })
  return alternatives
}

function testComparator (candidate, comparator) {
  if (comparator.operator === 'any') return true
  const order = compareVersions(candidate, comparator.version)
  switch (comparator.operator) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    case '=': return order === 0
    default: throw new Error(`unsupported comparator operator: ${comparator.operator}`)
  }
}

function satisfies (rawVersion, rawRange, options = {}) {
  const includePrerelease = options.includePrerelease === true
  const candidate = parseVersion(rawVersion)
  const alternatives = parseRange(rawRange, includePrerelease)
  for (const comparators of alternatives) {
    if (comparators.length === 0) return true
    if (!comparators.every((comparator) => testComparator(candidate, comparator))) continue
    if (candidate.prerelease.length > 0 && !includePrerelease) {
      // semver only lets a prerelease satisfy a set that mentions a
      // prerelease of the same [major, minor, patch] tuple.
      const allowed = comparators.some((comparator) =>
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === candidate.major &&
        comparator.version.minor === candidate.minor &&
        comparator.version.patch === candidate.patch)
      if (!allowed) continue
    }
    return true
  }
  return false
}
// ── semver-lite:end ──

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

test('engines.dsh declares a valid semver range for the supported DSH versions', () => {
  const range = PACKAGE.engines?.dsh
  assert.equal(typeof range, 'string')
  assert.ok(range.trim().length > 0)
  assert.doesNotThrow(() => parseRange(range), 'engines.dsh must be a parseable semver range')
  assert.match(range, /^>=0\.1\.7/, 'the plugin claims support from DSH 0.1.7 onwards')
  assert.equal(satisfies('0.2.1-rc.5', range, { includePrerelease: true }), true,
    'the current DSH runtime satisfies the range')
  assert.equal(satisfies('0.2.0-rc.2', range, { includePrerelease: true }), true)
  assert.equal(satisfies('0.1.7-alpha.1', range, { includePrerelease: true }), true,
    'prereleases of the lowest supported version stay inside the range')
  assert.equal(satisfies('0.1.7', range, { includePrerelease: true }), true)
  assert.equal(satisfies('0.1.6-alpha.1', range, { includePrerelease: true }), false)
  assert.equal(satisfies('0.1.6', range, { includePrerelease: true }), false)
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
