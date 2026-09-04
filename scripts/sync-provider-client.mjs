#!/usr/bin/env node
// scripts/sync-provider-client.mjs — regenerate the BEGIN/END
// generated block in lib/client.js from the canonical provider-metadata
// table. Run after touching lib/providers/provider-metadata.js.
//
//   node scripts/sync-provider-client.mjs          # rewrite block in place
//   node scripts/sync-provider-client.mjs --check  # exit 1 on drift
//
// This is the producer half of the contract-closure 2.3.0 plan's
// `check:provider-client-sync` gate. The consumer half is
// scripts/check-provider-client-sync.mjs (CI entry point).
//
// The block lives between `// BEGIN GENERATED TRINITY PROVIDERS` and
// `// END GENERATED TRINITY PROVIDERS` lines. The rewrite PRESERVES
// every byte outside those markers (including explanatory comments);
// only the `{ id, env }` rows between `var PROVIDERS = [` and the
// closing `];` are recomputed from provider-metadata.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'lib/client.js')

const isCheck = process.argv.includes('--check')

const { PROVIDER_METADATA } = await import('../lib/providers/provider-metadata.js')

// Render the body of the var PROVIDERS = [ ... ]; assignment. We
// return only the inner content (rows + opening bracket + closing
// bracket) so the script can splice it cleanly between the existing
// BEGIN/END markers without losing indentation context.
//
// The expected inner shape (matching lib/client.js v2.3.0+):
//
//     var PROVIDERS = [
//       { id: "alpha",  env: "ALPHA_API_KEY" },
//       { id: "bravo",  env: "BRAVO_API_KEY" },
//     ];
function renderBlock() {
  const lines = ['var PROVIDERS = [']
  for (const m of PROVIDER_METADATA) {
    if (!m.showInCredentialUi) continue
    if (m.credential.mode === 'none') continue
    lines.push(`      { id: ${JSON.stringify(m.id)}, env: ${JSON.stringify(m.credential.canonicalRef)} },`)
  }
  lines.push('    ];')
  return lines.join('\n')
}

const BEGIN_MARKER = '// BEGIN GENERATED TRINITY PROVIDERS'
const END_MARKER = '// END GENERATED TRINITY PROVIDERS'

const src = readFileSync(CLIENT_PATH, 'utf8')
const beginIdx = src.indexOf(BEGIN_MARKER)
const endIdx = src.indexOf(END_MARKER)
if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
  console.error('[sync:provider-client] lib/client.js does not contain BEGIN/END markers; add them before invoking sync.')
  process.exit(2)
}

// The body sits between the BEGIN and END markers. Its top-level shape
// is:
//   BEGIN_MARKER\n\nvar PROVIDERS = [...];\n    END_MARKER
// (i.e. a blank line after the BEGIN marker, the var declaration, then
// a newline + 4-space indent before the END marker).
//
// We replace `var PROVIDERS = [ ... ];` exactly. Everything else
// between BEGIN and END — typically just whitespace — is preserved
// verbatim so adding a future `// ── note here ──` comment between
// markers does not get clobbered.
const betweenStart = beginIdx + BEGIN_MARKER.length
const betweenEnd = endIdx
const between = src.slice(betweenStart, betweenEnd)

// Locate the var PROVIDERS = [ ... ]; block within the body.
const arrOpen = between.indexOf('var PROVIDERS = [')
const arrClose = between.indexOf('];', arrOpen === -1 ? 0 : arrOpen)
if (arrOpen === -1 || arrClose === -1 || arrClose <= arrOpen) {
  console.error('[sync:provider-client] could not find var PROVIDERS = [ ... ]; within the BEGIN/END block')
  process.exit(2)
}
// arrClose points at ']' of '];'; include the closing ';'.
const replaceEnd = arrClose + 2

const newBlockBody = renderBlock()
const newBetween = between.slice(0, arrOpen) + newBlockBody + between.slice(replaceEnd)
const newSrc = src.slice(0, betweenStart) + newBetween + src.slice(betweenEnd)

if (isCheck) {
  if (src === newSrc) {
    console.log('[sync:provider-client] lib/client.js matches the canonical provider-metadata block — OK')
    process.exit(0)
  }
  console.error('[sync:provider-client] drift detected:')
  console.error('  re-run without --check to update lib/client.js from provider-metadata.')
  process.exit(1)
}

if (src === newSrc) {
  console.log('[sync:provider-client] lib/client.js already up to date — nothing to do')
  process.exit(0)
}

writeFileSync(CLIENT_PATH, newSrc)
console.log('[sync:provider-client] rewrote lib/client.js — re-run pnpm run check:provider-client-sync --check to confirm')
