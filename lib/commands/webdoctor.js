// lib/commands/webdoctor.js — /webdoctor slash command (SPEC §II.10).
//
// Wired against lib/doctor/probe.js. Passive by default; respects the
// activeProbe flag from the user's command line.

export const COMMAND_NAME = 'webdoctor'

/**
 * @param {{ probe?: any }} opts
 */
export function createCommand(opts) {
  return {
    name: COMMAND_NAME,
    description: 'Diagnose DSH Trinity state — providers, credentials, adapters, cache, proxy, identity, migration.',
    async execute(args) {
      const probe = opts && opts.probe
      if (!probe || typeof probe.run !== 'function') {
        return { severity: 'unknown', message: 'doctor not initialized' }
      }
      return probe.run({ activeProbe: !!(args && args.activeProbe) })
    },
  }
}
