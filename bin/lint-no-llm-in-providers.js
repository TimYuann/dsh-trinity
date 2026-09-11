#!/usr/bin/env node
// bin/lint-no-llm-in-providers.js — Contract A boundary lint (SPEC §II.3.1).
//
// Searches lib/providers/ and lib/adapters/ for any reference to ctx.llm,
// ctx.tools, or model-side APIs. Adapters and providers must NEVER call
// the LLM or invoke other Tools — that responsibility belongs to the
// Tool layer (lib/tools/*.js).

import { readFileSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const BANNED_PATTERNS = [
  /\bctx\.llm\b/,
  /\bctx\.tools\b/,
  /\bctx\.get\(['"]llm['"]\)/,
  /\bctx\.get\(['"]tools['"]\)/,
]

const ROOTS = ['lib/providers', 'lib/adapters']
const SCAN_EXT = new Set(['.js', '.ts'])

let violations = 0
for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  walk(path.resolve(root))
}

if (violations > 0) {
  console.error(`[lint-no-llm-in-providers] ${violations} violation(s)`)
  process.exit(1)
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    const ext = path.extname(full)
    if (!SCAN_EXT.has(ext)) continue
    const text = readFileSync(full, 'utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const re of BANNED_PATTERNS) {
        if (re.test(line)) {
          // Ignore lines that look like comments describing the rule.
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
          console.error(`${full}:${i + 1}: ${line}`)
          violations++
          break
        }
      }
    }
  }
}
