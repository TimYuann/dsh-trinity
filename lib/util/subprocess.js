// lib/util/subprocess.js — subprocess wrapper for adapters (SPEC §II.7).
//
// Wraps the HOST `ctx.subprocess` seam with the safety guarantees the
// adapters need: timeout, abort signal propagation, stdout/stderr cap, and
// **parameter arrays** (not shell strings) for every spawned process.
//
// Per SPEC §II.7:
//   - "Adapters' secondary requests (e.g. `git clone`, `gh api`,
//     `yt-dlp`) must use parameter arrays, not shell strings."
//   - "Subprocess must support timeout, abort signal, stdout/stderr cap."
//
// DSH 0.2.1-rc.5 contract (verified against @deepseek-ai/dsh-subprocess
// lib/types/types.d.ts and @deepseek-ai/dsh-subprocess-local):
//
//   ctx.subprocess.spawn(spec: SubprocessSpawnSpec): SubprocessHandle
//     spec.argv          readonly string[]      — argv[0] is the program
//     spec.cwd           string                 — REQUIRED, no default
//     spec.stdio         SubprocessStdio        — REQUIRED, no defaults:
//                      { stdin: 'ignore'|'pipe'|{data},
//                        stdout: 'pipe'|'inherit'|{maxBytes, spill?},
//                        stderr: ... }
//     spec.graceMs       number                 — REQUIRED termination grace
//     spec.signal        AbortSignal?           — starts termination on abort
//     spec.env           NodeJS.ProcessEnv?     — merged onto the SCRUBBED
//                                                parent base; a string value
//                                                is a deliberate opt-in and
//                                                survives the credential scrub
//
//   handle.done         Promise<SubprocessOutcome>  — { exitCode, signal }
//   handle.collected    { stdout?, stderr? }    — offset readers (collect mode)
//   handle.terminate()  void                    — the ONLY termination verb
//   handle.waitForExit(signal?) Promise<boolean>
//
// There is NO `timeout` and NO `timeoutMs` in the seam: the CALLER owns
// deadlines. This wrapper owns one: on timeout it calls `terminate()` and
// resolves with a partial result plus `truncated: true` (the historical
// behaviour), never a rejection.
//
// There is deliberately NO `node:child_process` fallback any more. The old
// fallback silently escaped the Host's process containment (the audit that
// produced this rewrite found every adapter still on it: `gh`, `yt-dlp`,
// `ffprobe`, `opencli` all spawned outside the Host). When the seam is
// missing we fail with a coded error instead, so the caller can degrade
// with a reason.
//
// Two behaviours of the seam are worth stating explicitly, because they
// differ from the old child_process path:
//
//   * `spec.env` is MERGED onto the Host's scrubbed parent base. A key the
//     caller wants REMOVED must be given as `undefined` — the seam's
//     tombstone. Omitting a key leaves the base value in place.
//   * A collected stream keeps the TAIL, not the head (SubprocessCollect:
//     "Collected text — the TAIL of the stream when truncated"). We request
//     no `spill`, so a truncated stream's head is simply gone.

const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1 MiB
const DEFAULT_TIMEOUT_MS = 30_000
// Termination grace handed to the seam, and the extra window we wait for the
// managed range to empty before we stop waiting at all.
// Termination grace handed to the seam when WE terminate the process.
// It is NOT added to the caller's deadline: on timeout the collected bytes
// are returned immediately.
const GRACE_MS = 2_000
// How long we wait for the managed process range to empty after the command
// itself reported its outcome. Bounded and short: a survivor must not hang
// the caller, and the caller owns the deadline.
const WAIT_FOR_EXIT_MS = 500
// Sentinel for the timeout race.
const TIMED_OUT = Symbol('dsh-trinity.subprocess.timed-out')

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
// `ffprobe`, `git`, `opencli` — anything else throws SECURITY before
// spawn.
//
// `opencli` (the X adapter's browser bridge) is listed deliberately:
// this check constrains WHICH PROGRAM runs, not what that program does.
// opencli itself loads user-overridable adapters under ~/.opencli/clis,
// so this allowlist is not a capability boundary — see the security note
// at the top of lib/adapters/x.js. It is still worth having: it keeps a
// URL-derived string from ever becoming argv[0].
const ALLOWED_BINARIES = new Set([
  'gh', 'yt-dlp', 'ffmpeg', 'ffprobe', 'git', 'opencli',
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
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/**
 * Resolve the Host (Cordis) context from whatever the caller holds.
 *
 * The Tool layer passes the plugin context directly; the fetch adapters
 * receive the *fetch* context (the object that carries `policy`,
 * `settings` and `publicFetch`), which keeps the plugin context under
 * `.ctx`. Both shapes are accepted so no call site has to unwrap by hand.
 *
 * @param {any} ctx
 * @returns {any} the plugin context, or null
 */
export function hostContext(ctx) {
  if (!ctx) return null
  if (typeof ctx.get === 'function') return ctx
  if (ctx.ctx && typeof ctx.ctx.get === 'function') return ctx.ctx
  return null
}

/**
 * Run one allowlisted external program through the Host subprocess seam.
 *
 * @param {any} ctx — the plugin context (or a fetch context carrying it);
 *                    `ctx.subprocess` must be mounted
 * @param {SubprocessSpec} spec
 * @returns {Promise<SubprocessResult>}
 */
export async function runSubprocess(ctx, spec) {
  if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    throw codedError('INVALID_INPUT', 'subprocess argv must be a non-empty string array')
  }
  // R3 P1 #9: argv[0] (program name) must be on the allowlist. We do
  // NOT trust shell-quoting here — only the literal binary name is
  // permitted. Path prefixes are tolerated (`/usr/bin/yt-dlp`) but only
  // when the basename matches an entry.
  const programName = basename(spec.argv[0])
  if (!ALLOWED_BINARIES.has(programName)) {
    throw codedError('SECURITY', `subprocess program not in allowlist: ${JSON.stringify(spec.argv[0])}`)
  }
  for (const a of spec.argv) {
    if (typeof a !== 'string' || a.length === 0) {
      throw codedError('INVALID_INPUT', 'subprocess argv entries must be non-empty strings (no shell interpolation)')
    }
    if (/[;&|<>`$\\\n\r]/.test(a)) {
      throw codedError('SECURITY', `subprocess argv contains shell metacharacter: ${JSON.stringify(a)}`)
    }
  }

  const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS
  const maxBytes = spec.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES
  const startedAt = Date.now()

  const host = hostContext(ctx)
  const seam = host ? host.get('subprocess') : null
  if (!seam || typeof seam.spawn !== 'function') {
    throw codedError('SUBPROCESS_UNAVAILABLE', 'the host subprocess service is not mounted')
  }

  let handle
  try {
    handle = seam.spawn({
      argv: spec.argv,
      cwd: spec.cwd || process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: GRACE_MS,
      ...(spec.signal ? { signal: spec.signal } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    })
  } catch (e) {
    // A spawn failure (bad cwd, missing executable) rejects or throws here.
    if (e && typeof e.code === 'string') throw e
    throw codedError('SPAWN_FAILED', `failed to spawn ${JSON.stringify(spec.argv[0])}: ${e && e.message ? e.message : String(e)}`)
  }

  return collectHandle(handle, timeoutMs, startedAt, spec.signal)
}

/**
 * Read one collected stream from the handle. The seam's readers are
 * offset-based and non-consuming; `readFrom(0)` after settlement returns the
 * retained tail. `lossy` means the head slid out of the in-memory window —
 * and because we request no `spill`, the seam kept no copy of it, so the
 * head is simply gone.
 *
 * @param {any} reader
 * @returns {{ text: string, truncated: boolean }}
 */
function readCollected(reader) {
  if (!reader || typeof reader.readFrom !== 'function') return { text: '', truncated: false }
  try {
    const r = reader.readFrom(0)
    if (!r || typeof r !== 'object') return { text: '', truncated: false }
    return {
      text: typeof r.text === 'string' ? r.text : '',
      truncated: r.lossy === true,
    }
  } catch {
    return { text: '', truncated: false }
  }
}

/**
 * @param {any} handle
 * @param {number} timeoutMs
 * @param {number} startedAt
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<SubprocessResult>}
 */
async function collectHandle(handle, timeoutMs, startedAt, signal) {
  let timedOut = false

  const settled = handle.done.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )

  // The seam has no timeout: the CALLER owns deadlines. On timeout we
  // terminate the managed range and resolve IMMEDIATELY with whatever was
  // collected — the seam keeps collected output readable after the command
  // exits, so no valid byte is discarded. Waiting for `done` here would
  // stretch the caller's budget by the termination grace, and the adapters
  // deliberately keep a slice of the host's web_fetch budget for their
  // degradation path (see lib/adapters/x.js).
  let timeoutTimer = null
  const timeout = new Promise((resolve) => {
    if (timeoutMs <= 0) return
    timeoutTimer = setTimeout(() => {
      timedOut = true
      try { handle.terminate() } catch { /* ignore */ }
      resolve(TIMED_OUT)
    }, timeoutMs)
  })

  const raced = await Promise.race([settled, timeout])
  // The command may finish first; then the deadline timer must not linger
  // and terminate a handle that is already done.
  if (timeoutTimer) clearTimeout(timeoutTimer)

  if (raced !== TIMED_OUT && raced.ok === false) throw raced.error

  const outcome = raced !== TIMED_OUT && raced.ok === true ? raced.value : null

  // Let the managed range empty so no survivor keeps running behind us.
  // The wait is BOUNDED and short: a survivor must not hang the caller, and
  // the caller owns the deadline.
  if (!timedOut) {
    const waitController = new AbortController()
    const waitTimer = setTimeout(() => waitController.abort(), WAIT_FOR_EXIT_MS)
    const onCallerAbort = () => waitController.abort()
    if (signal) {
      if (signal.aborted) waitController.abort()
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    try { await handle.waitForExit(waitController.signal) } catch { /* ignore */ }
    clearTimeout(waitTimer)
    if (signal) signal.removeEventListener('abort', onCallerAbort)
  }

  const stdout = readCollected(handle.collected && handle.collected.stdout)
  const stderr = readCollected(handle.collected && handle.collected.stderr)

  return {
    exitCode: outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null,
    signal: (outcome && outcome.signal) || (timedOut ? 'SIGTERM' : null),
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: Date.now() - startedAt,
    ...(timedOut || stdout.truncated || stderr.truncated ? { truncated: true } : {}),
  }
}
