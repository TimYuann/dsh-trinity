#!/usr/bin/env node
// scripts/check-no-llm-in-providers.mjs — Contract A boundary lint
// (SPEC §II.3.1).
//
// Searches lib/providers/ and lib/adapters/ for any reference to ctx.llm,
// ctx.tools, or model-side APIs. Adapters and providers must NEVER call
// the LLM or invoke other Tools — that responsibility belongs to the
// Tool layer (lib/tools/*.js).
//
// This is a thin packaged form of bin/lint-no-llm-in-providers.js so
// the `pnpm run check:no-llm-in-providers` script target keeps a
// predictable name for CI (lint:* is reserved by some linters; we want
// a `check:*` family in scripts/).

import { readFileSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'

const BANNED_PATTERNS = [
  /\bctx\.llm\b/,
  /\bctx\.tools\b/,
  /\bctx\.get\(['"]llm['"]\)/,
  /\bctx\.get\(['"]tools['"]\)/,
]

const ROOTS = ['lib/providers', 'lib/adapters']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) walk(full, out)
    else if (s.isFile() && full.endsWith('.js')) out.push(full)
  }
  return out
}

const violations = []
for (const root of ROOTS) {
  let files = []
  try { files = walk(root) } catch { continue }
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const pat of BANNED_PATTERNS) {
      if (pat.test(src)) {
        violations.push(`${f}: ${pat}`)
        break
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`[check:no-llm-in-providers] ${violations.length} violation(s):`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('[check:no-llm-in-providers] OK')
