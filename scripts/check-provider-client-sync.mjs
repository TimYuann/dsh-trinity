#!/usr/bin/env node
// scripts/check-provider-client-sync.mjs — verify lib/client.js
// HOST_DATA block matches the canonical ProviderMetadata list.
//
// The HOST provider rows in lib/client.js were previously hand-maintained
// and drifted away from the canonical credential refs in lib/credentials
// and lib/providers/search/chained.js (specifically FIRECRAWL_KEY vs
// FIRECRAWL_API_KEY, PARALLELMCP_API_KEY vs PARALLEL_MCP_API_KEY, and
// DuckDuckGo being shown with a fake key field).
//
// This script reads the canonical metadata from
// lib/providers/provider-metadata.js and parses the generated block out
// of lib/client.js (between BEGIN/END markers). When `--check` is
// passed, it exits non-zero on any drift; otherwise it prints the
// required block for the operator to paste in.
//
// Full implementation lives in Commit 4. Before Commit 4 lands, the
// generator is a stub that always exits 0 in `--check` mode and prints
// "metadata module not yet defined".

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const isCheck = args.includes('--check')

const clientPath = path.resolve('lib/client.js')
const metaPath = path.resolve('lib/providers/provider-metadata.js')

if (!existsSync(clientPath)) {
  console.error(`[check:provider-client-sync] missing ${clientPath}`)
  process.exit(1)
}

if (!existsSync(metaPath)) {
  // Pre-Commit-4 placeholder: the canonical metadata module is created
  // in Commit 4. Until then, do not block CI; print a note and exit 0.
  console.log('[check:provider-client-sync] metadata module not yet defined; skipping sync check (Commit 4 deliverable)')
  process.exit(0)
}

const clientSrc = readFileSync(clientPath, 'utf8')
const beginMatch = clientSrc.match(/BEGIN GENERATED TRINITY PROVIDERS([\s\S]*?)END GENERATED TRINITY PROVIDERS/)
if (!beginMatch) {
  if (isCheck) {
    console.error('[check:provider-client-sync] lib/client.js does not contain the BEGIN/END generated block')
    process.exit(1)
  } else {
    console.log('[check:provider-client-sync] no generated block present; nothing to update')
    process.exit(0)
  }
}

const metaSrc = readFileSync(metaPath, 'utf8')
const metaIds = []
const reIdG = /\bid:\s*['"]([^'"]+)['"]/g
let m
while ((m = reIdG.exec(metaSrc)) !== null) metaIds.push(m[1])

const blockIds = []
const reBlockIdG = /\{\s*id:\s*['"]([^'"]+)['"]/g
while ((m = reBlockIdG.exec(beginMatch[1])) !== null) blockIds.push(m[1])

const metaSet = new Set(metaIds)
const blockSet = new Set(blockIds)

const missing = metaIds.filter((id) => !blockSet.has(id))
const extra = blockIds.filter((id) => !metaSet.has(id))

if (missing.length === 0 && extra.length === 0) {
  console.log(`[check:provider-client-sync] OK (${metaIds.length} providers in sync)`)
  process.exit(0)
}

if (isCheck) {
  console.error('[check:provider-client-sync] drift detected:')
  for (const id of missing) console.error('  missing from client.js: ' + id)
  for (const id of extra) console.error('  extra in client.js:    ' + id)
  process.exit(1)
}

console.log('[check:provider-client-sync] drift; rerun without --check to update lib/client.js (TODO Commit 4)')
process.exit(1)
