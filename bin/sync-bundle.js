#!/usr/bin/env node
// bin/sync-bundle.js — sync cwd/lib to the dev-profile node_modules.
//
// WHY THIS EXISTS (2026-08-21 incident):
//   pnpm `file:` install does NOT guarantee hardlinks for every file:
//   - new files added after install (e.g. lib/errors.js) are NOT auto-linked
//     and a missing-file `Cannot find module` crash kills the dsh process
//   - some files are hardlinked, others are copied; behavior depends on
//     pnpm heuristics (file size, executable bit, etc.) that change across
//     versions
//
//   This script mirrors `cwd/lib/` -> `node_modules/dsh-trinity/lib/`
//   so any tool error reaches the live bundle, no matter what pnpm did.
//
// USAGE:
//   node bin/sync-bundle.js            # sync to default dev profile
//   node bin/sync-bundle.js web        # sync to web profile (4599)
//   node bin/sync-bundle.js --check   # exit 1 if out of sync, no copy
//
// AFTER SYNC, restart the dsh process to pick up the new files:
//   kill <PID> ; dsh --profile dev --port 4600 > /tmp/dsh-4600.log 2>&1 &

import { readdirSync, statSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const cwd = here.replace(/\/bin$/, '')

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

// Resolve the live bundle directory name. npm name (package.json#name)
// is the truth; `DTRINITY_BUNDLE_DIR` is an escape hatch for forks /
// local renames without a sync-bundle edit.
function resolveBundleDirName() {
  if (process.env.DTRINITY_BUNDLE_DIR) return process.env.DTRINITY_BUNDLE_DIR
  const pkg = readPackageJson()
  if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name
  return 'dsh-trinity'
}

// package.json#files is the ship contract, and it negates some lib/
// subtrees (currently `!lib/_deferred` -- deferred adapters deliberately
// kept out of the tarball). An installed bundle therefore never contains
// them, so a --check that walks all of lib/ reports them MISSING forever
// and the gate can never pass.
//
// Mirror the negations here rather than hardcoding a second list: the two
// drifted apart once already, when `!lib/_deferred` was added to
// package.json without touching this script.
function excludedLibPaths() {
  const files = readPackageJson().files
  if (!Array.isArray(files)) return new Set()
  const out = new Set()
  for (const entry of files) {
    if (typeof entry !== 'string' || !entry.startsWith('!')) continue
    const rel = entry.slice(1).replace(/^\.\//, '')
    if (rel.startsWith('lib/')) out.add(rel.slice('lib/'.length))
  }
  return out
}

// DSH's own home convention: `$DSH_HOME` when set, else `~/.dsh`. Deriving
// the profile roots here keeps the script portable (no machine-specific
// absolute path in a tracked file) and matches how dsh itself locates a
// profile — see the launcher's `dshHomePath()`.
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const PROFILES = {
  dev: join(DSH_HOME, 'profiles/dev'),
  web: join(DSH_HOME, 'profiles/web'),
  devHeadless: join(DSH_HOME, 'profiles/dev-headless'),
  headless: join(DSH_HOME, 'profiles/headless'),
  'dev-clean': join(DSH_HOME, 'profiles/dev-clean'),
  // A user-defined profile path can be passed as the FIRST positional arg
  // (overrides the default). Example:
  //   node bin/sync-bundle.js /Users/me/.dsh/profiles/custom
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const positional = args.find((a) => !a.startsWith('--')) || 'dev'
// Positional arg can be a known profile NAME or an absolute profile PATH.
let profile
if (PROFILES[positional]) {
  profile = PROFILES[positional]
} else if (positional.startsWith('/')) {
  profile = positional
} else {
  console.error(`Unknown profile: ${positional}. Known: ${Object.keys(PROFILES).join(', ')} (or pass an absolute path)`)
  process.exit(2)
}

const bundleDirName = resolveBundleDirName()
const liveRoot = join(profile, 'node_modules', bundleDirName)
if (!existsSync(liveRoot)) {
  console.error(`Live bundle not found at ${liveRoot}. Is the dsh-trinity plugin installed into the "${positional}" profile? (looked for node_modules/${bundleDirName}/)`)
  process.exit(2)
}

const excluded = excludedLibPaths()

/**
 * Recursively collect file paths under `dir`, skipping .git, node_modules,
 * .pnpm-store, and any lib/ subtree that package.json#files excludes from
 * the shipped bundle.
 * @param {string} dir
 * @param {string} [relPrefix]  path of `dir` relative to lib/
 * @returns {string[]} absolute paths
 */
function walk(dir, relPrefix = '') {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.pnpm-store' || entry === '.orchestra') continue
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry
    if (excluded.has(rel)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, rel))
    else if (st.isFile()) out.push(full)
  }
  return out
}

// v2.2: also sync cordis.patch.yml — pnpm `file:` installs COPY the patch
// file (not a hardlink), so bundle-patch changes (e.g. tool-web fetch)
// never reached the live profile before this fix.
const cwdFiles = [...walk(join(cwd, 'lib')), join(cwd, 'cordis.patch.yml')]
let drifted = 0
for (const f of cwdFiles) {
  const rel = relative(join(cwd, 'lib'), f)
  const live = rel.startsWith('..') ? join(liveRoot, relative(cwd, f)) : join(liveRoot, 'lib', rel)
  if (!existsSync(live)) {
    if (checkOnly) {
      console.error(`MISSING: ${rel}`)
      drifted++
      continue
    }
    copyFileSync(f, live)
    console.log(`+ added  ${rel}`)
    drifted++
    continue
  }
  const a = readFileSync(f)
  const b = readFileSync(live)
  if (!a.equals(b)) {
    if (checkOnly) {
      console.error(`DIFFERS: ${rel}`)
      drifted++
      continue
    }
    copyFileSync(f, live)
    console.log(`~ synced ${rel}`)
    drifted++
  }
}

if (checkOnly) {
  if (drifted > 0) {
    console.error(`\n${drifted} file(s) out of sync. Run: node bin/sync-bundle.js ${positional}`)
    process.exit(1)
  }
  console.log(`OK — all ${cwdFiles.length} files in sync with ${profile} profile`)
  process.exit(0)
}

console.log(`\n${drifted} file(s) synced. Restart dsh to load.`)
