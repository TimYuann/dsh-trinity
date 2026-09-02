// lib/util/subprocess.js — subprocess wrapper for adapters (SPEC §II.7).
//
// Wraps `ctx.subprocess.spawn` with the safety guarantees the adapters
// need: timeout, abort signal propagation, stdout/stderr cap, and
// **parameter arrays** (not shell strings) for every spawned process.
//
// Per SPEC §II.7:
//   - "Adapters' secondary requests (e.g. `git clone`, `gh api`,
//     `yt-dlp`) must use parameter arrays, not shell strings."
//   - "Subprocess must support timeout, abort signal, stdout/stderr cap."
//
// We treat `ctx.subprocess` as the authoritative seam. When the seam is
// absent (older DSH / sandbox), we degrade to a `node:child_process`
// fallback that still satisfies the same contract, accepting an argv
// array.

const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1 MiB
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Path-aware basename helper (handles `/usr/bin/yt-dlp` → `yt-dlp` and
 * `yt-dlp` → `yt-dlp`).
 * @param {string} p
 */
function basename(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

// R3 P1 #9: argv[0] (the program name) is restricted to a small
// allowlist. We do not trust PATH lookup; the wrapper only invokes the
// binaries the adapters actually need. `gh`, `yt-dlp`, `ffmpeg`,
// `ffprobe`, `git` — anything else throws SECURITY before spawn.
const ALLOWED_BINARIES = new Set([
  'gh', 'yt-dlp', 'ffmpeg', 'ffprobe', 'git',
])

/**
 * @typedef {{
 *   argv: string[],
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   signal?: AbortSignal,
 * }} SubprocessSpec
 *
 * @typedef {{
 *   exitCode: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number,
 *   truncated?: boolean,
 * }} SubprocessResult
 */

/**
 * @param {any} ctx
 * @param {SubprocessSpec} spec
 * @returns {Promise<SubprocessResult>}
 */
export async function runSubprocess(ctx, spec) {
  if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    const e = new Error('subprocess argv must be a non-empty string array')
    e.code = 'INVALID_INPUT'
    throw e
  }
  // R3 P1 #9: argv[0] (program name) must be on the allowlist. We do
  // NOT trust shell-quoting here — only the literal binary name is
  // permitted. Path prefixes are tolerated (`/usr/bin/yt-dlp`) but only
  // when the basename matches an entry.
  const programName = basename(spec.argv[0])
  if (!ALLOWED_BINARIES.has(programName)) {
    const e = new Error(`subprocess program not in allowlist: ${JSON.stringify(spec.argv[0])}`)
    e.code = 'SECURITY'
    throw e
  }
  for (const a of spec.argv) {
    if (typeof a !== 'string' || a.length === 0) {
      const e = new Error('subprocess argv entries must be non-empty strings (no shell interpolation)')
      e.code = 'INVALID_INPUT'
      throw e
    }
    if (/[;&|<>`$\\\n\r]/.test(a)) {
      const e = new Error(`subprocess argv contains shell metacharacter: ${JSON.stringify(a)}`)
      e.code = 'SECURITY'
      throw e
    }
  }
  const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS
  const maxBytes = spec.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES
  const startedAt = Date.now()

  if (ctx && typeof ctx.get === 'function') {
    const sub = ctx.get('subprocess')
    if (sub && typeof sub.spawn === 'function') {
      return runViaSeam(sub, spec, timeoutMs, maxBytes, startedAt)
    }
  }
  // Fallback: node:child_process.spawn with argv + timeout + size cap.
  return runViaChildProcess(spec, timeoutMs, maxBytes, startedAt)
}

async function runViaSeam(sub, spec, timeoutMs, maxBytes, startedAt) {
  const handle = sub.spawn({
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    signal: spec.signal,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return collectHandle(handle, timeoutMs, maxBytes, startedAt)
}

async function runViaChildProcess(spec, timeoutMs, maxBytes, startedAt) {
  const { spawn } = await import('node:child_process')
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    signal: spec.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return collectChildProcess(child, timeoutMs, maxBytes, startedAt)
}

function collectHandle(handle, timeoutMs, maxBytes, startedAt) {
  return new Promise((resolve, reject) => {
    let timer = null
    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let errBytes = 0
    let truncated = false

    const finalize = (exitCode, signal, isTruncated) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...(isTruncated ? { truncated: true } : {}),
      })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // R3 P1 #14: when the subprocess times out we resolve with a
        // partial result + `truncated: true` so adapters can decide
        // whether the partial output is usable. Previously we rejected
        // outright, dropping any valid bytes the child had already
        // produced.
        truncated = true
        try { handle.terminate && handle.terminate() } catch { /* ignore */ }
        finalize(null, 'SIGTERM', true)
      }, timeoutMs)
    }

    try {
      handle.onStdout && handle.onStdout((chunk) => {
        if (outBytes >= maxBytes) {
          truncated = true
          try { handle.cancelStdout && handle.cancelStdout() } catch { /* ignore */ }
          return
        }
        const s = chunk && typeof chunk.toString === 'function' ? chunk.toString() : String(chunk)
        outBytes += Buffer.byteLength(s, 'utf8')
        if (outBytes > maxBytes) {
          const cut = maxBytes - (outBytes - Buffer.byteLength(s, 'utf8'))
          stdout += s.slice(0, Math.max(0, cut))
          truncated = true
        } else {
          stdout += s
        }
      })
      handle.onStderr && handle.onStderr((chunk) => {
        if (errBytes >= maxBytes) return
        const s = chunk && typeof chunk.toString === 'function' ? chunk.toString() : String(chunk)
        errBytes += Buffer.byteLength(s, 'utf8')
        if (errBytes > maxBytes) {
          const cut = maxBytes - (errBytes - Buffer.byteLength(s, 'utf8'))
          stderr += s.slice(0, Math.max(0, cut))
        } else {
          stderr += s
        }
      })
    } catch (e) {
      // ignore listener-attach failures
    }

    if (handle.done && typeof handle.done.then === 'function') {
      handle.done.then(
        (r) => finalize(r && typeof r.exitCode === 'number' ? r.exitCode : null, r && r.signal || null, truncated),
        (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        },
      )
    } else if (typeof handle.wait === 'function') {
      handle.wait().then(
        (r) => finalize(r && typeof r.exitCode === 'number' ? r.exitCode : null, r && r.signal || null, truncated),
        (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        },
      )
    } else {
      // Last-ditch: wait 50ms then resolve with what we have.
      setTimeout(() => finalize(null, null, truncated), 50)
    }
  })
}

function collectChildProcess(child, timeoutMs, maxBytes, startedAt) {
  return new Promise((resolve, reject) => {
    let timer = null
    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let errBytes = 0
    let truncated = false

    const finish = (code, signal, isTruncated) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...(isTruncated ? { truncated: true } : {}),
      })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // R3 P1 #14: resolve with partial result on timeout.
        truncated = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
        finish(null, 'SIGTERM', true)
      }, timeoutMs)
    }

    child.stdout && child.stdout.on('data', (chunk) => {
      if (outBytes >= maxBytes) { truncated = true; return }
      const s = chunk.toString()
      outBytes += Buffer.byteLength(s, 'utf8')
      if (outBytes > maxBytes) {
        const cut = maxBytes - (outBytes - Buffer.byteLength(s, 'utf8'))
        stdout += s.slice(0, Math.max(0, cut))
        truncated = true
      } else {
        stdout += s
      }
    })
    child.stderr && child.stderr.on('data', (chunk) => {
      if (errBytes >= maxBytes) return
      const s = chunk.toString()
      errBytes += Buffer.byteLength(s, 'utf8')
      if (errBytes > maxBytes) {
        const cut = maxBytes - (errBytes - Buffer.byteLength(s, 'utf8'))
        stderr += s.slice(0, Math.max(0, cut))
      } else {
        stderr += s
      }
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      finish(code, signal, truncated)
    })
  })
}
