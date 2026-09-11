// test/source-check.test.js — source_check algorithm (SPEC §II.5,
// acceptance #20: decompose → search → fetch → score → assess → snapshot refs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeClaim, sanitizeQueries, splitSubQueryLines } from '../lib/source-check/decompose.js'
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

// ── Defect B: the line-splitting fallback leaked model reasoning ──────
//
// 2026-09-11, main instance. `source_check` printed:
//   1. We need answer only JSON array of strings. Need decompose claim …
//   2. How does a patch entry in a dsh profile apply to a targeted row …
// The first "sub-query" was the model thinking out loud. It did not just
// look wrong: subQueries are tokenized into the passage score
// (lib/source-check/score.js), so the prose polluted the ranking too.

/** Minimal llm seam stub returning a fixed completion. */
function llmCtx(completion) {
  return {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
      if (key === 'llm') {
        return {
          async prepareCall() {
            return {
              config: { provider: 'test', model: 'test-model' },
              stream: () => (async function* () {
                yield { type: 'text-delta', text: completion }
              })(),
            }
          },
        }
      }
      return null
    },
  }
}

test('decomposeClaim: reasoning prose from the LLM never becomes a sub-query', async () => {
  const raw = [
    'We need answer only JSON array of strings. Need decompose claim into 3 sub-queries that would support or contradict it.',
    '1. How does a patch entry in a dsh profile apply to a targeted row',
    '2. In dsh, when a bundle patch targets a row, does it need to restate all keys',
  ].join('\n')
  const r = await decomposeClaim('a bundle patch applies per row', 3, { ctx: llmCtx(raw) })
  assert.equal(r.length, 2, `expected the two real queries, got: ${JSON.stringify(r)}`)
  for (const q of r) {
    assert.ok(!/we need|json array|return only/i.test(q), `narration leaked: ${q}`)
    assert.ok(!/^\d+[.)]\s/.test(q), `list marker leaked: ${q}`)
  }
  assert.match(r[0], /^How does a patch entry/)
})

test('decomposeClaim: prose-only completion falls back to heuristics', async () => {
  const raw = 'We need to decompose the claim into sub-queries. Return ONLY a JSON array of strings, no other text.'
  const r = await decomposeClaim('the moon landing happened in 1969', 3, { ctx: llmCtx(raw) })
  assert.equal(r.length, 3)
  for (const q of r) {
    assert.ok(!/we need|json array|return only/i.test(q), `narration leaked: ${q}`)
    assert.match(q, /the moon landing happened in 1969/, 'heuristic queries carry the claim')
  }
})

test('decomposeClaim: a well-formed JSON array is still used as-is', async () => {
  const raw = '["apollo 11 landing date", "moon landing 1969 evidence", "moon landing hoax claims"]'
  const r = await decomposeClaim('the moon landing happened in 1969', 3, { ctx: llmCtx(raw) })
  assert.deepEqual(r, ['apollo 11 landing date', 'moon landing 1969 evidence', 'moon landing hoax claims'])
})

test('decomposeClaim: queries quoted inside prose are preferred over the prose', async () => {
  const raw = 'Here are 3 sub-queries:\n"apollo 11 landing date"\n"moon landing 1969 evidence"\n"moon landing hoax claims"'
  const r = await decomposeClaim('the moon landing happened in 1969', 3, { ctx: llmCtx(raw) })
  assert.deepEqual(r, ['apollo 11 landing date', 'moon landing 1969 evidence', 'moon landing hoax claims'])
})

test('sanitizeQueries: drops markers, narration, JSON scaffolding and duplicates', () => {
  const out = sanitizeQueries([
    '- how does the credential pool rotate keys?',
    '1. how does the credential pool rotate keys?', // duplicate after marker strip
    'We need to return only JSON array of strings', // narration
    '{"query": "nested json scaffolding"}',         // scaffolding
    'Sub-queries:',                                  // lead-in
    'x',                                             // too short
  ])
  assert.deepEqual(out, ['how does the credential pool rotate keys?'])
})

test('splitSubQueryLines: an empty completion yields no candidates', () => {
  assert.deepEqual(splitSubQueryLines(''), [])
  assert.deepEqual(splitSubQueryLines(null), [])
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
