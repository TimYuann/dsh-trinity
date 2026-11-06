// test/helpers/fake-subprocess.js — a test-only implementation of the DSH
// 0.2.1 `ctx.subprocess` seam, backed by node:child_process.
//
// The plugin no longer falls back to node:child_process on its own (that
// fallback escaped the Host's process containment), so tests that need a
// REAL process — the X adapter installs a shim script on PATH and asserts
// the exact argv it received — must supply the seam themselves.
//
// The fake speaks the current contract:
//   spec  → { argv, cwd, stdio: { stdin, stdout: { maxBytes }, stderr: { maxBytes } },
//             graceMs, signal?, env? }
//   handle→ { stdin, stdout, stderr, control, collected: { stdout, stderr },
//             done, terminate(), waitForExit(signal?) }

import { spawn } from 'node:child_process'

/**
 * @param {any} spec
 * @returns {any} a SubprocessHandle-shaped object
 */
function spawnViaChildProcess(spec) {
  const maxOut = spec.stdio && spec.stdio.stdout && spec.stdio.stdout.maxBytes
  const maxErr = spec.stdio && spec.stdio.stderr && spec.stdio.stderr.maxBytes
  const env = { ...process.env, ...(spec.env || {}) }

  let child
  try {
    child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {},
      done: Promise.reject(e),
      terminate() {},
      waitForExit: async () => true,
    }
  }

  const out = { text: '', truncated: false }
  const err = { text: '', truncated: false }

  // The HOST keeps the TAIL of a truncated stream (SubprocessCollect:
  // "Collected text — the TAIL of the stream when truncated") and reports
  // `lossy` when the head slid out. The double does the same, so a test
  // cannot pass against a more forgiving collector than the real one.
  const collect = (stream, bucket, cap) => {
    if (!stream) return
    stream.on('data', (chunk) => {
      const s = chunk.toString()
      bucket.text += s
      if (bucket.text.length > cap) {
        bucket.text = bucket.text.slice(bucket.text.length - cap)
        bucket.truncated = true
      }
    })
  }
  collect(child.stdout, out, maxOut || Infinity)
  collect(child.stderr, err, maxErr || Infinity)

  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(e))
    child.on('close', (code, signal) => resolve({ exitCode: code === null ? null : code, signal: signal || null }))
  })

  const reader = (bucket) => ({
    readFrom: () => ({
      text: bucket.text,
      nextOffset: bucket.text.length,
      lossy: bucket.truncated,
    }),
  })

  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(out), stderr: reader(err) },
    done,
    terminate() {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    },
    waitForExit: async () => true,
  }
}

/**
 * Build a stub plugin context that exposes the fake subprocess service.
 *
 * @param {Record<string, any>} [extra] — other services the code may ask for
 * @returns {any} an object with a `get(name)` method
 */
export function fakeHostContext(extra = {}) {
  return {
    get(name) {
      if (name === 'subprocess') {
        return { spawn: spawnViaChildProcess }
      }
      return extra[name]
    },
  }
}
