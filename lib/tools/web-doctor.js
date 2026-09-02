// lib/tools/web-doctor.js — web_doctor Tool (SPEC §II.5, acceptance #19).
//
// Default behaviour is passive: read-only, no network calls, no credential
// state changes. The `activeProbe: true` argument is an explicit opt-in for
// real probes (HTTP pings, subprocess `which` checks).

import { defineTool } from '../schema/define-tool.js'
import { toLosslessJson } from '../util/lossless-json.js'

export const TOOL_NAME = 'web_doctor'

export const PARAMETERS = {
  activeProbe: { type: 'boolean', description: 'Set true to perform real probes (HTTP pings, subprocess checks)' },
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      severity: { type: 'string' },
      activeProbe: { type: 'boolean' },
      providers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            credentialMode: { type: 'string' },
            credentials: { type: 'string' },
            lastErrorClass: { type: 'string' },
            // v2.2.1: explicitly declare lastPing's inner fields so the host
            // validator accepts them whether or not the shim defaults strict.
            lastPing: {
              type: 'object',
              additionalProperties: false,
              properties: {
                status: { type: 'string' },
                reason: { type: 'string' },
                latencyMs: { type: 'integer' },
                httpStatus: { type: 'integer' },
              },
            },
          },
        },
      },
      adapters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            activeBackend: { type: 'string' },
            tier: { type: 'integer' },
            cheap: { type: 'boolean' },
            enabled: { type: 'boolean' },
            status: { type: 'string' },
          },
        },
      },
      cache: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'integer' },
          bytes: { type: 'integer' },
          oldestFetchedAt: { type: 'integer' },
          hardCharCap: { type: 'integer' },
        },
      },
      proxy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configured: { type: 'boolean' },
          fromEnv: { type: 'boolean' },
        },
      },
      identity: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionIdField: { type: 'string' },
        },
      },
      model: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          capabilities: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hostedSearch: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  render(_args, value) {
    if (!value || typeof value !== 'object') return []
    const blocks = [{ type: 'text', text: `Severity: ${value.severity || 'unknown'}` }]
    if (Array.isArray(value.providers)) {
      blocks.push({ type: 'text', text: '\nProviders:' })
      for (const p of value.providers) {
        const last = p.lastErrorClass ? ` (last: ${p.lastErrorClass})` : ''
        let ping = ''
        if (p.lastPing && typeof p.lastPing === 'object') {
          const lp = p.lastPing
          ping = ` ping=${lp.status || 'unknown'}`
          if (typeof lp.latencyMs === 'number') ping += ` ${lp.latencyMs}ms`
          if (typeof lp.httpStatus === 'number') ping += ` http=${lp.httpStatus}`
          if (typeof lp.reason === 'string' && lp.reason.length > 0) ping += ` (${lp.reason})`
        }
        blocks.push({ type: 'text', text: `  - ${p.id} [${p.credentialMode}] ${p.credentials || ''}${last}${ping}` })
      }
    }
    if (Array.isArray(value.adapters)) {
      blocks.push({ type: 'text', text: '\nAdapters:' })
      for (const a of value.adapters) {
        blocks.push({ type: 'text', text: `  - ${a.id} [${a.activeBackend || '?'}] cheap=${!!a.cheap} enabled=${!!a.enabled}` })
      }
    }
    if (value.cache && typeof value.cache === 'object') {
      blocks.push({ type: 'text', text: `\nCache: ${value.cache.entries} entries / ${value.cache.bytes} bytes / hardCharCap=${value.cache.hardCharCap}` })
    }
    if (value.migration && typeof value.migration === 'object') {
      blocks.push({ type: 'text', text: `\nMigration: version=${value.migration.version} conflicts=${(value.migration.conflicts || []).join(',') || 'none'}` })
    }
    return blocks
  },
}

/**
 * @param {{ probe?: any, ctx?: any, settings?: any }} opts
 */
export function createTool(opts) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Diagnose DSH Trinity state — providers, credentials, adapters, cache, proxy, identity, migration. Default passive (no network).',
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) {
        const e = new Error('Aborted')
        e.name = 'AbortError'
        e.code = 'ABORTED'
        throw e
      }
      const probe = opts && opts.probe
      if (!probe || typeof probe.run !== 'function') {
        const e = new Error('web_doctor probe not initialised')
        e.code = 'MISSING_CTX'
        throw e
      }
      // v2.2: sanitize at the boundary (lossless-JSON contract).
      return toLosslessJson(await probe.run({ activeProbe: args && args.activeProbe === true }))
    },
  })
}
