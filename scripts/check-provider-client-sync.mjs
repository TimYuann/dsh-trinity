#!/usr/bin/env node
// scripts/check-provider-client-sync.mjs — CI gate that asserts the
// BEGIN/END generated block in lib/client.js matches the canonical
// provider-metadata table.
//
//   pnpm run check:provider-client-sync         # silently OK
//   pnpm run check:provider-client-sync --check # exit non-zero on drift
//
// The sync producer lives at scripts/sync-provider-client.mjs. This
// script delegates to it in --check mode so the gate and the writer
// speak the same language; the gate never lies about drift.
//
// Pre-v2.3.0 the script silently passed because no BEGIN/END markers
// existed; review round 2 caught that as silent drift. After this
// rewrite the script enforces a real consistency check.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SYNC = path.join(__dirname, 'sync-provider-client.mjs')

const args = [SYNC]
if (process.argv.includes('--check')) args.push('--check')

const result = spawnSync('node', args, { stdio: 'inherit' })
process.exit(result.status === null ? 1 : result.status)
