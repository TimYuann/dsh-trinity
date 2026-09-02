// test/adapters/routing.test.js — Acceptance #10: adapter routing URL matrix.
//
// Per SPEC §II.6: every cheap adapter's canHandle() must match the
// expected URL shapes; matchSpecializedAdapter() must return the
// expected adapter (or null when no match); and GenericHTML must NOT
// appear in the matchAdapter result — GenericHTML is the
// content-type dispatch target only.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSpecializedAdapter, genericHtmlAdapter } from '../../lib/adapters/index.js'
import * as github from '../../lib/adapters/github.js'
import * as youtube from '../../lib/adapters/youtube.js'
import * as rss from '../../lib/adapters/rss.js'
import * as pdf from '../../lib/adapters/pdf.js'

// ── github canHandle ───────────────────────────────────────────────
test('AC #10: github.canHandle matches github.com owner/repo + subpaths', () => {
  for (const u of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/blob/main/README.md',
    'https://github.com/owner/repo/pull/123',
    'https://github.com/owner/repo/issues/456',
    'https://www.github.com/owner/repo',
  ]) {
    assert.equal(github.canHandle(u), true, u)
  }
})
test('github.canHandle rejects non-github.com hosts', () => {
  for (const u of [
    'https://gitlab.com/owner/repo',
    'https://bitbucket.org/owner/repo',
    'https://example.com/foo/bar',
  ]) {
    assert.equal(github.canHandle(u), false, u)
  }
})
test('github.canHandle rejects single-segment paths', () => {
  assert.equal(github.canHandle('https://github.com/'), false)
  assert.equal(github.canHandle('https://github.com/owner'), false)
})

// ── youtube canHandle ──────────────────────────────────────────────
test('AC #10: youtube.canHandle matches youtube.com + youtu.be', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=abc',
    'https://m.youtube.com/shorts/abc',
    'https://youtu.be/dQw4w9WgXcQ',
  ]) {
    assert.equal(youtube.canHandle(u), true, u)
  }
})
test('youtube.canHandle rejects non-youtube hosts', () => {
  for (const u of [
    'https://vimeo.com/123',
    'https://example.com',
  ]) {
    assert.equal(youtube.canHandle(u), false, u)
  }
})

// ── rss canHandle ─────────────────────────────────────────────────
test('AC #10: rss.canHandle matches /rss, /feed, /atom, .xml', () => {
  for (const u of [
    'https://example.com/rss',
    'https://example.com/rss.xml',
    'https://example.com/feed',
    'https://example.com/feed/atom',
    'https://example.com/atom.xml',
    'https://example.com/index.rss',
    'https://example.com/index.xml',
    'https://example.com/index.atom',
  ]) {
    assert.equal(rss.canHandle(u), true, u)
  }
})
test('rss.canHandle rejects arbitrary HTML pages', () => {
  for (const u of [
    'https://example.com/',
    'https://example.com/about',
    'https://example.com/blog/post-1',
  ]) {
    assert.equal(rss.canHandle(u), false, u)
  }
})

// ── pdf canHandle ─────────────────────────────────────────────────
test('AC #10: pdf.canHandle matches .pdf extension', () => {
  for (const u of [
    'https://example.com/file.pdf',
    'https://example.com/path/document.pdf',
    'https://example.com/file.pdf?download=1',
  ]) {
    assert.equal(pdf.canHandle(u), true, u)
  }
})
test('AC #11 prerequisite: pdf.canHandle does NOT match /file (no .pdf)', () => {
  // The /file URL routes to GenericHTML through content-type dispatch
  // when the response Content-Type is application/pdf.
  assert.equal(pdf.canHandle('https://example.com/file'), false)
})

// ── matchSpecializedAdapter URL matrix ─────────────────────────────
test('AC #10: matchSpecializedAdapter dispatches by URL', () => {
  assert.equal(matchSpecializedAdapter('https://github.com/o/r')?.id, 'github')
  assert.equal(matchSpecializedAdapter('https://www.youtube.com/watch?v=x')?.id, 'youtube')
  assert.equal(matchSpecializedAdapter('https://example.com/rss')?.id, 'rss')
  assert.equal(matchSpecializedAdapter('https://example.com/file.pdf')?.id, 'pdf')
})
test('AC #10 + #11: matchSpecializedAdapter returns null for non-matching URL', () => {
  assert.equal(matchSpecializedAdapter('https://example.com/'), null)
  assert.equal(matchSpecializedAdapter('https://example.com/file'), null, 'no .pdf → null; PDF routing happens through content-type dispatch')
  assert.equal(matchSpecializedAdapter('https://example.com/about'), null)
  assert.equal(matchSpecializedAdapter(''), null)
})
test('AC #10: matchSpecializedAdapter never returns GenericHTML (GenericHTML is dispatch-only)', () => {
  // Even when canHandle() could in theory accept a URL, GenericHTML is
  // NOT in the registry — it is the content-type dispatch target.
  for (const u of [
    'https://example.com/',
    'https://example.com/about',
    'https://example.com/post/1',
    'https://example.com/random.html',
  ]) {
    const m = matchSpecializedAdapter(u)
    if (m) assert.notEqual(m.id, 'genericHtml', `matchAdapter returned genericHtml for ${u}`)
  }
})
