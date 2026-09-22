// lib/commands/webdoctor.js — /webdoctor slash command (SPEC §II.10).
//
// Wired against lib/doctor/probe.js. Passive by default; `--active` (also
// `--probe`, or a bare `active`) opts into real probes.
//
// DSH contract (see ./invocation.js for the verified detail):
//   ctx.commands.register({ name, description, handler })  ← `handler`, not `execute`
//   handler(invocation) → { kind: 'success', text } | { kind: 'error', text }
//
// `execute(args)` below is the structured core: it still returns the raw doctor
// report so the command stays unit-testable and machine-readable.
// `handler(invocation)` is the DSH entry point, and it renders that report with
// the very same formatter the `web_doctor` Tool uses
// (lib/tools/web-doctor.js#OUTPUT.render), so the tool card and the slash
// command can never drift apart.

import { rawArgs, hasFlag, asSuccess, asError } from './invocation.js'
import { OUTPUT as DOCTOR_OUTPUT } from '../tools/web-doctor.js'

export const COMMAND_NAME = 'webdoctor'

/**
 * @param {{ probe?: any }} opts
 */
export function createCommand(opts) {
  const command = {
    name: COMMAND_NAME,
    description: 'Diagnose DSH Trinity state — providers, credentials, adapters, cache, proxy, identity, migration.',
    input: { hint: '[--active]' },

    /**
     * Structured core. Returns the raw doctor report, or
     * `{ ok: false, code: 'NO_PROBE', message }` when the probe is missing.
     *
     * @param {{ activeProbe?: boolean }} [args]
     */
    async execute(args) {
      const probe = opts && opts.probe
      if (!probe || typeof probe.run !== 'function') {
        return { ok: false, code: 'NO_PROBE', message: 'webdoctor: doctor probe is not initialised' }
      }
      return probe.run({ activeProbe: !!(args && args.activeProbe) })
    },

    /**
     * DSH entry point.
     *
     * @param {{ rawInput?: string }} invocation
     */
    async handler(invocation) {
      const raw = rawArgs(invocation)
      const report = await command.execute({ activeProbe: hasFlag(raw, 'active', 'probe') })
      if (report && report.ok === false) return asError(report.message, 'webdoctor: probe unavailable')
      return asSuccess(renderReport(report))
    },
  }
  return command
}

/**
 * Render the doctor report with the Tool's own formatter.
 *
 * @param {any} report
 * @returns {string}
 */
function renderReport(report) {
  if (!report || typeof report !== 'object') return 'Severity: unknown (empty report)'
  let text = ''
  try {
    const blocks = DOCTOR_OUTPUT.render({}, report)
    if (Array.isArray(blocks)) {
      text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n').trim()
    }
  } catch {
    text = ''
  }
  return text.length > 0 ? text : `Severity: ${report.severity || 'unknown'}`
}
