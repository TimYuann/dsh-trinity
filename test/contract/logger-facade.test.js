// test/contract/logger-facade.test.js — the logger facade's argument rule.
//
// `lib/logger.js` exposes `warn/info/debug(message, errOrMeta?, meta?)`.
// When the SECOND argument is a plain meta object, the facade treats it as
// the metadata and DROPS the third one — so a call that hides its
// explanation in a third argument logs the tag and nothing else. That is
// not a style question: it silently emptied every warning the plugin wrote
// before 2.4.3.
//
// `error(message, err?, meta?)` is different — the facade keeps the meta
// there — so this guard only covers the levels that lose it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from '../../lib/logger.js'

const LIB_ROOT = fileURLToPath(new URL('../../lib/', import.meta.url))

/** Every .js file under lib/, excluding the deferred subtree. */
function libFiles(dir = LIB_ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '_deferred') continue
      libFiles(full, out)
      continue
    }
    if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Count the top-level arguments of a call that starts at `start` (the index
 * of its opening parenthesis).
 */
function argumentCount(source, start) {
  let depth = 0
  let commas = 0
  let inString = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return commas + 1
      continue
    }
    if (ch === ',' && depth === 1) commas++
  }
  return commas + 1
}

test('no warn/info/debug call passes a third argument the facade would drop', () => {
  const offenders = []
  for (const file of libFiles()) {
    const source = readFileSync(file, 'utf8')
    const pattern = /\.(warn|info|debug)\(/g
    let match
    while ((match = pattern.exec(source)) !== null) {
      const open = match.index + match[0].length - 1
      const count = argumentCount(source, open)
      if (count > 2) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${file.replace(LIB_ROOT, 'lib/')}:${line} — .${match[1]}() takes ${count} arguments`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these calls lose their explanation (the facade drops a third argument when the second is a plain meta object):\n${offenders.join('\n')}`)
})

test('the facade itself drops the third argument for a plain meta second argument', () => {
  // The behaviour the guard above protects, pinned directly.
  const seen = []
  const logger = createLogger({ logger: { warn: (...args) => seen.push(args) } }, { keys: [] })
  logger.warn('web-access-chain.apply', { phase: 'skills' })
  logger.warn('web-access-chain.apply: the explanation', { phase: 'skills' })
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0], ['web-access-chain.apply', { phase: 'skills' }],
    'a third argument would never reach the sink')
  assert.equal(seen[1][0], 'web-access-chain.apply: the explanation',
    'the explanation must travel in the first argument')
})
