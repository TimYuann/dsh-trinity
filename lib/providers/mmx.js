// lib/providers/mmx.js — cwd-specific fallback (NOT part of 25-provider count).
// v1.0.0: keep v0.1.0 spawn flow, fix P1-1 (ISO-8601 normalisation for mmx
// "2026-02-04 23:39:58" → "2026-02-04T23:39:58.000Z") and add isMmxAvailable.

import { spawn, execFileSync } from 'node:child_process'
import { toIso8601 } from '../iso8601.js'

let cachedMmxAvailable = null

export function isMmxAvailable() {
  if (cachedMmxAvailable !== null) return cachedMmxAvailable
  try {
    const out = execFileSync('which', ['mmx'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    cachedMmxAvailable = typeof out === 'string' && out.trim().length > 0
  } catch {
    cachedMmxAvailable = false
  }
  return cachedMmxAvailable === true
}

/** @returns {Promise<{ sources: any[], truncated: boolean }>} */
export function mmxSearch(query, numResults, signal) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn('mmx', [
        'search', 'query',
        '--q', query,
        '--output', 'json',
        '--quiet',
      ], { signal })
    } catch (e) {
      reject(new Error('mmx spawn failed: ' + (e.message || e)))
      return
    }

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    proc.on('error', (err) => reject(new Error('mmx spawn error: ' + err.message)))
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('mmx exit ' + code + ': ' + stderr.slice(0, 300)))
        return
      }
      let data
      try { data = JSON.parse(stdout) }
      catch (e) {
        reject(new Error('mmx: invalid json (' + e.message + '): ' + stdout.slice(0, 200)))
        return
      }
      const organic = Array.isArray(data.organic) ? data.organic : []
      const sources = organic
        .filter((r) => r && typeof r.link === 'string' && r.link.length > 0)
        .slice(0, numResults)
        .map((r) => {
          const out = { url: r.link }
          if (r.title) out.title = String(r.title)
          if (r.snippet) out.snippet = String(r.snippet)
          if (r.date) {
            const iso = toIso8601(r.date)
            if (iso) out.publishedAt = iso
          }
          return out
        })
      if (sources.length === 0) reject(new Error('mmx: empty results'))
      else resolve({ sources, truncated: organic.length > numResults })
    })
  })
}