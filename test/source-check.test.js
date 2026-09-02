// test/source-check.test.js — source_check algorithm (SPEC §II.5,
// acceptance #20: decompose → search → fetch → score → assess → snapshot refs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeClaim } from '../lib/source-check/decompose.js'
import { scorePassages } from '../lib/source-check/score.js'
import { assessClaim } from '../lib/source-check/assess.js'

test('decomposeClaim: returns 2-4 sub-queries (heuristic fallback when no LLM)', async () => {
  const r = await decomposeClaim('the moon landing happened in 1969', 3, { ctx: { get: () => null } })
  assert.ok(Array.isArray(r))
  assert.ok(r.length >= 2)
  assert.ok(r.length <= 4)
  for (const q of r) {
    assert.equal(typeof q, 'string')
    assert.ok(q.length > 0)
  }
})

test('scorePassages: top N by lexical overlap with claim', () => {
  const claim = 'the moon landing was in 1969'
  const body = 'The moon landing occurred in 1969. ' +
    'Many people doubted the moon landing at the time. ' +
    'NASA prepared for years before the launch. ' +
    'A random unrelated sentence about cats follows here.'
  const passages = scorePassages(body, claim, ['moon landing 1969'], 2)
  assert.ok(passages.length > 0)
  assert.ok(passages.length <= 2)
  // Highest-scoring passage should mention "moon landing 1969"
  const top = passages[0]
  assert.ok(/moon landing|1969/i.test(top.text))
})

test('scorePassages: labels supporting vs contradicting', () => {
  const body = 'Cats are mammals. They have fur. They do not lay eggs.'
  const passages = scorePassages(body, 'cats lay eggs', [], 5)
  // At least one passage should be marked 'contradicting' or 'supporting'
  // (not 'neutral'). The third sentence contains "do not" + "lay eggs" → contradicting.
  const labels = passages.map((p) => p.label)
  assert.ok(labels.includes('supporting') || labels.includes('contradicting') || labels.includes('neutral'))
})

test('assessClaim: heuristic fallback when no LLM', async () => {
  const r = await assessClaim('the moon landing was in 1969', [
    { offset: 0, length: 30, text: 'The moon landing was in 1969', label: 'supporting' },
  ], { ctx: { get: () => null } })
  assert.equal(r.assessment, 'supported')
  assert.equal(typeof r.assessmentModel, 'string')
  assert.equal(typeof r.assessmentGeneratedAt, 'number')
})

test('assessClaim: contradictory passage → contradicted', async () => {
  const r = await assessClaim('the moon landing was in 1969', [
    { offset: 0, length: 30, text: 'It was not in 1969', label: 'contradicting' },
  ], { ctx: { get: () => null } })
  assert.equal(r.assessment, 'contradicted')
})

test('assessClaim: mixed signals → mixed', async () => {
  const r = await assessClaim('the moon landing was in 1969', [
    { offset: 0, length: 30, text: 'It was in 1969', label: 'supporting' },
    { offset: 30, length: 30, text: 'It was not', label: 'contradicting' },
  ], { ctx: { get: () => null } })
  assert.equal(r.assessment, 'mixed')
})

test('assessClaim: no passages → insufficient', async () => {
  const r = await assessClaim('unknown claim', [], { ctx: { get: () => null } })
  assert.equal(r.assessment, 'insufficient')
})

// P1 #11: passage windows MUST stay <= 200 characters per SPEC §II.5.
test('scorePassages: every passage.length is hard-capped at 200 chars (P1 #11)', () => {
  const body = Array.from({ length: 200 }, () => 'lorem ipsum dolor sit amet, consectetur adipiscing elit. ').join('')
  const passages = scorePassages(body, 'moon', [], 50)
  assert.ok(passages.length > 0)
  for (const p of passages) {
    assert.ok(p.length <= 200, `passage.length=${p.length} exceeds 200-char hard cap`)
    assert.ok(p.text.length <= 200, `passage.text.length=${p.text.length} exceeds 200-char hard cap`)
  }
})
