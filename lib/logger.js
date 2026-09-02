// lib/logger.js — soft ctx.logger abstraction (DESIGN §1.2)
//
// Returns a Logger facade that prefers ctx.logger when the bundle's inject
// list resolved it, falling back to console.* otherwise. Every error()
// call runs the message through redactCredential against the keys the bundle
// learned about (caller passes them at create time via { keys }), so secret
// leakage into stderr becomes a bug instead of a default behaviour.

/**
 * @typedef {object} LogMeta
 * @property {string} [provider]
 * @property {string} [tool]
 * @property {string} [phase]
 * @property {number} [elapsedMs]
 */

/**
 * @typedef {object} Logger
 * @property {(msg: string, errOrMeta?: Error | LogMeta, meta?: LogMeta) => void} debug
 * @property {(msg: string, errOrMeta?: Error | LogMeta, meta?: LogMeta) => void} info
 * @property {(msg: string, errOrMeta?: Error | LogMeta, meta?: LogMeta) => void} warn
 * @property {(msg: string, err?: Error | unknown, meta?: LogMeta) => void} error
 */

/**
 * Build a logger facade.
 *
 * @param {any} ctx  cordis Context (or null/undefined).
 * @param {{ keys?: string[] }} [opts]
 * @returns {Logger}
 */
export function createLogger(ctx, opts = {}) {
  const keys = Array.isArray(opts.keys) ? opts.keys.filter((k) => typeof k === 'string' && k.length > 0) : []
  const upstream = ctx && typeof ctx.logger === 'object' && ctx.logger ? ctx.logger : null

  function redact(text) {
    if (typeof text !== 'string' || keys.length === 0) return text
    let out = text
    for (const k of keys) {
      if (typeof k === 'string' && k.length > 0) {
        out = out.split(k).join('[redacted]')
      }
    }
    return out
  }

  function emit(level, args) {
    const redactedArgs = args.map((a) => (typeof a === 'string' ? redact(a) : a))
    if (upstream && typeof upstream[level] === 'function') {
      try {
        upstream[level](...redactedArgs)
        return
      } catch {
        // fall through to console
      }
    }
    const fn = console[level === 'debug' ? 'debug' : level] || console.log
    try {
      fn(...redactedArgs)
    } catch {
      // never throw from logger
    }
  }

  return {
    debug(msg, errOrMeta, meta) { emitWithErr(emit, 'debug', msg, errOrMeta, meta, redact) },
    info(msg, errOrMeta, meta) { emitWithErr(emit, 'info', msg, errOrMeta, meta, redact) },
    warn(msg, errOrMeta, meta) { emitWithErr(emit, 'warn', msg, errOrMeta, meta, redact) },
    error(msg, err, meta) {
      // err is optional; pass through after redacting the err.message when present
      let safeErr = err
      if (err && typeof err === 'object' && typeof err.message === 'string') {
        try {
          safeErr = Object.assign(Object.create(Object.getPrototypeOf(err)), err, { message: redact(err.message) })
        } catch {
          safeErr = err
        }
      }
      const args = safeErr !== undefined ? [msg, safeErr] : [msg]
      if (meta) args.push(meta)
      emit('error', args)
    },
  }
}

/**
 * Emit a log line. The second arg may be either a meta object OR an Error
 * (mirroring `error()`); the third arg is the meta object. The heuristic:
 * Error-like objects have a `name` string and a `message` string. Anything
 * else is treated as meta.
 *
 * @param {(level: string, args: any[]) => void} emit  closure from createLogger
 * @param {'debug' | 'info' | 'warn'} level
 * @param {string} msg
 * @param {Error | object | undefined} errOrMeta
 * @param {object | undefined} meta
 * @param {(text: string) => string} redact  closure from createLogger
 */
function emitWithErr(emit, level, msg, errOrMeta, meta, redact) {
  let err, realMeta
  if (
    errOrMeta &&
    typeof errOrMeta === 'object' &&
    typeof errOrMeta.name === 'string' &&
    typeof errOrMeta.message === 'string'
  ) {
    err = errOrMeta
    realMeta = meta
  } else {
    realMeta = errOrMeta
  }
  if (err) {
    const args = [msg, redactErrorLike(err, redact)]
    if (realMeta) args.push(realMeta)
    emit(level, args)
    return
  }
  emit(level, realMeta ? [msg, realMeta] : [msg])
}

/**
 * Clone an Error-like with redacted message; fall back to a plain
 * object representation when clone fails.
 *
 * @param {Error} err
 * @param {(text: string) => string} redact
 */
function redactErrorLike(err, redact) {
  try {
    const proto = Object.getPrototypeOf(err)
    return Object.assign(Object.create(proto), err, { message: redact(err.message) })
  } catch {
    return { name: err.name || 'Error', message: redact(String(err)) }
  }
}