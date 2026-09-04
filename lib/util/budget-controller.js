// lib/util/budget-controller.js — explicit hierarchical cancellation
// (v2.3.0 § Commit 3.6).
//
// Replaces the v2.2 `Promise.race([promise, timeout])` pattern that
// could not truly abort the underlying work. Every layer of the search
// chain now owns a BudgetController:
//
//     total search controller
//       └─ provider controller
//            └─ credential attempt controller
//                 └─ optional retry attempt controller
//
// On timeout the controller's signal aborts. The provider receives
// that signal and can react with `AbortSignal`-aware APIs (fetch, our
// safeHttpFetch, etc.). The runner awaits the task's abort settlement
// before retrying.
//
// The constructor returns an object with dispose() so callers can
// release timers in a `finally` block.

const DEFAULT_TIMEOUT_CLASS = 'budget'

/**
 * @typedef {{
 *   signal: AbortSignal,
 *   dispose: () => void,
 *   didTimeout: () => boolean,
 * }} BudgetController
 *
 * @param {{
 *   parentSignal?: AbortSignal | undefined,
 *   timeoutMs?: number,
 *   timeoutClass?: string,
 *   onTimeout?: (err: Error) => void,
 * }} [opts]
 * @returns {BudgetController | null}
 */
export function createBudgetController(opts = {}) {
  const parentSignal = opts.parentSignal
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 0
  if (!parentSignal && timeoutMs <= 0) {
    return null
  }

  const ac = new AbortController()
  let timedOut = false
  let timer = null

  // Combine parent abort with our timeout.
  const inputs = []
  if (parentSignal) inputs.push(parentSignal)
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      const err = makeTimeoutError(opts.timeoutClass || DEFAULT_TIMEOUT_CLASS, timeoutMs)
      try { opts.onTimeout && opts.onTimeout(err) } catch { /* ignore */ }
      try { ac.abort(err) } catch { ac.abort() }
    }, timeoutMs)
    // Note: timer is NOT unref'd so the abort path always fires even
    // when the test's only pending work is the abort listener.
  }

  if (parentSignal) {
    if (parentSignal.aborted) {
      try { ac.abort(parentSignal.reason) } catch { ac.abort() }
      timedOut = false
    } else {
      const onAbort = () => {
        try { ac.abort(parentSignal.reason) } catch { ac.abort() }
      }
      parentSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return {
    signal: ac.signal,
    didTimeout: () => timedOut,
    dispose() {
      try { if (timer) clearTimeout(timer) } catch { /* ignore */ }
      timer = null
    },
  }
}

function makeTimeoutError(klass, ms) {
  const e = new Error(`budget exhausted after ${ms}ms`)
  e.name = klass === 'budget' ? 'BudgetError' : 'AbortError'
  e.code = klass === 'budget' ? 'WEB_SEARCH_TIMEOUT' : 'ABORTED'
  e.class = klass === 'budget' ? 'budget' : 'aborted'
  return e
}
