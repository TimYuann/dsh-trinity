// lib/providers/fetch/ssrf.js — validateRemoteUrl + DNS preflight + allowRanges (DESIGN §1.11)
//
// Replicates the security checks from pi-web-access ssrf-protection.ts:
// 1. protocol must be http/https
// 2. hostname present + non-internal
// 3. IPv4/IPv6 blacklists (10/8, 127/8, 169.254/16, 172.16/12, 192.168/16,
//    198.18/15, 0/8, 100.64/10, 224/4, ::, ::1, fc00::/7, fe80::/10, IPv4-mapped)
// 4. DNS preflight: every resolved IP must also pass the blacklist
// 5. domain policy allow/deny (whitelist / blacklist by hostname)
// 6. trustEnvProxy=true skips DNS lookup (but domain policy still enforced)

import net from 'node:net'
import dns from 'node:dns/promises'
import { toolError } from '../../errors.js'

const IPV4_BLOCKED = [
  { network: '0.0.0.0', prefix: 8 },
  { network: '10.0.0.0', prefix: 8 },
  { network: '127.0.0.0', prefix: 8 },
  { network: '100.64.0.0', prefix: 10 },
  { network: '169.254.0.0', prefix: 16 },
  { network: '172.16.0.0', prefix: 12 },
  { network: '192.168.0.0', prefix: 16 },
  { network: '198.18.0.0', prefix: 15 },
  { network: '224.0.0.0', prefix: 4 },
]

const IPV6_BLOCKED = [
  { network: '::1', prefix: 128 },
  { network: '::', prefix: 128 },
  { network: 'fc00::', prefix: 7 },
  { network: 'fe80::', prefix: 10 },
]

const HOSTNAME_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/**
 * Normalise hostname: lower-case, strip trailing dot, strip IPv6 brackets.
 *
 * @param {string} host
 * @returns {string}
 */
export function normalizeHostname(host) {
  if (typeof host !== 'string') return ''
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/**
 * Parse a CIDR literal (IPv4 or IPv6) into { network, prefix }.
 *
 * @param {string} cidr
 * @returns {{ network: string, prefix: number, family: 4 | 6 }}
 */
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      'CIDR must be a string',
      'internal — pass a string CIDR (e.g. "10.0.0.0/8") to allowRanges',
    )
  }
  const idx = cidr.indexOf('/')
  if (idx <= 0) {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      `Invalid CIDR (missing /prefix): ${cidr}`,
      'internal — CIDR must include /prefix (e.g. "10.0.0.0/8" not "10.0.0.0")',
    )
  }
  const network = cidr.slice(0, idx).trim()
  const prefixStr = cidr.slice(idx + 1).trim()
  if (!/^\d+$/.test(prefixStr)) {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      `Invalid CIDR prefix: ${prefixStr}`,
      'internal — CIDR prefix must be 0-32 (IPv4) or 0-128 (IPv6)',
    )
  }
  const prefix = Number(prefixStr)
  const family = net.isIP(network)
  if (family === 0) {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      `Invalid CIDR address: ${network}`,
      'internal — check CIDR syntax (e.g. "192.168.1.0/24")',
    )
  }
  if (family === 4 && (prefix < 0 || prefix > 32)) {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      `Invalid IPv4 prefix ${prefix}`,
      'internal — IPv4 prefix must be 0-32 (e.g. "192.168.1.0/24")',
    )
  }
  if (family === 6 && (prefix < 0 || prefix > 128)) {
    throw toolError(
      'ssrf',
      'INVALID_CIDR',
      `Invalid IPv6 prefix ${prefix}`,
      'internal — IPv6 prefix must be 0-128 (e.g. "fc00::/7")',
    )
  }
  return { network, prefix, family: family }
}

/**
 * @param {string} ip
 * @param {string} network
 * @param {number} prefix
 * @param {4 | 6} family
 * @returns {boolean}
 */
function ipInCidr(ip, network, prefix, family) {
  if (net.isIP(ip) !== family) return false
  // Convert to BigInt for full-width compare (IPv6 needs 128-bit compare).
  const buf = (s) => {
    const parts = family === 4 ? s.split('.') : s.split(':')
    if (family === 4) return BigInt(parts[0]) * BigInt(16777216) + BigInt(parts[1]) * BigInt(65536) + BigInt(parts[2]) * BigInt(256) + BigInt(parts[3])
    // IPv6 — normalise first
    let addr = s
    if (addr.includes('::')) {
      const [l, r] = addr.split('::')
      const left = (l ? l.split(':') : [])
      const right = (r ? r.split(':') : [])
      const fill = 8 - left.length - right.length
      addr = [...left, ...Array(fill).fill('0'), ...right].join(':')
    }
    const words = addr.split(':')
    let v = BigInt(0)
    for (const w of words) v = v * BigInt(65536) + BigInt(parseInt(w || '0', 16))
    return v
  }
  const ipVal = buf(ip)
  const netVal = buf(network)
  const mask = family === 4
    ? (BigInt(0xffffffff) << BigInt(32 - prefix)) & BigInt(0xffffffff)
    : ((BigInt(1) << BigInt(128)) - BigInt(1)) ^ ((BigInt(1) << BigInt(128 - prefix)) - BigInt(1))
  return (ipVal & mask) === (netVal & mask)
}

/**
 * @param {string} ip
 * @param {string[]} allowRanges
 * @returns {boolean}
 */
export function isBlockedIPv4(ip, allowRanges) {
  if (net.isIP(ip) !== 4) return true
  for (const r of allowRanges || []) {
    try {
      const c = parseCidr(r)
      if (c.family === 4 && ipInCidr(ip, c.network, c.prefix, 4)) return false
    } catch { /* ignore bad range */ }
  }
  for (const c of IPV4_BLOCKED) {
    if (ipInCidr(ip, c.network, c.prefix, 4)) return true
  }
  return false
}

/**
 * @param {string} ip
 * @param {string[]} allowRanges
 * @returns {boolean}
 */
export function isBlockedIPv6(ip, allowRanges) {
  if (net.isIP(ip) !== 6) return true
  // Map IPv4-mapped IPv6 to IPv4 and re-check
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (m) return isBlockedIPv4(m[1], allowRanges)
  for (const r of allowRanges || []) {
    try {
      const c = parseCidr(r)
      if (c.family === 6 && ipInCidr(ip, c.network, c.prefix, 6)) return false
    } catch { /* ignore */ }
  }
  for (const c of IPV6_BLOCKED) {
    if (ipInCidr(ip, c.network, c.prefix, 6)) return true
  }
  return false
}

function domainMatchesPattern(host, pattern) {
  const h = normalizeHostname(host)
  const p = normalizeHostname(pattern)
  if (h === p) return true
  if (p.startsWith('*.') && h.endsWith(p.slice(1))) return true
  return false
}

/**
 * Validate a URL string for safe remote fetch.
 *
 * @param {string} urlString
 * @param {{ ssrf: { allowRanges: string[], trustEnvProxy: boolean },
 *           domainPolicy?: { allow: string[], deny: string[] } }} options
 * @returns {Promise<URL>}
 */
export async function validateRemoteUrl(urlString, options) {
  let url
  try {
    url = new URL(urlString)
  } catch {
    throw toolError(
      'web_fetch',
      'WEB_INVALID_URL',
      `Invalid URL: ${String(urlString).slice(0, 200)}`,
      'pass a fully-qualified URL starting with http:// or https://',
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw toolError(
      'web_fetch',
      'WEB_BLOCKED_URL',
      `Only HTTP and HTTPS URLs are allowed (got ${url.protocol})`,
      'web_fetch only supports http(s); for file:// or other schemes use a different tool',
    )
  }
  let hostname = normalizeHostname(url.hostname)
  if (!hostname) {
    throw toolError(
      'web_fetch',
      'WEB_BLOCKED_URL',
      'URL must include a hostname',
      'pass a URL with a real host (e.g. https://example.com/path)',
    )
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw toolError(
      'web_fetch',
      'WEB_BLOCKED_URL',
      `Blocked internal hostname: ${hostname}`,
      'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
    )
  }
  if (!HOSTNAME_REGEX.test(hostname)) {
    throw toolError(
      'web_fetch',
      'WEB_BLOCKED_URL',
      `Invalid hostname: ${hostname}`,
      'check the URL for typos in the host part (e.g. extra spaces, bad chars)',
    )
  }
  // domain policy
  const policy = options.domainPolicy || { allow: [], deny: [] }
  if (Array.isArray(policy.deny) && policy.deny.length > 0) {
    for (const d of policy.deny) {
      if (domainMatchesPattern(hostname, d)) {
        throw toolError(
          'web_fetch',
          'WEB_BLOCKED_URL',
          `Blocked by domain policy (deny): ${d}`,
          'remove the host via ctx.settings (path: web-access-chain.domainPolicy.deny), or use a different host',
        )
      }
    }
  }
  if (Array.isArray(policy.allow) && policy.allow.length > 0) {
    let allowed = false
    for (const a of policy.allow) {
      if (domainMatchesPattern(hostname, a)) { allowed = true; break }
    }
    if (!allowed) {
      throw toolError(
        'web_fetch',
        'WEB_BLOCKED_URL',
        `Not in domain policy allow list: ${hostname}`,
        'add the host via ctx.settings (path: web-access-chain.domainPolicy.allow), or pass trustEnvProxy=true to skip the allowlist',
      )
    }
  }

  // IP literal?
  const ipFamily = net.isIP(hostname)
  const allowRanges = (options.ssrf && options.ssrf.allowRanges) || []
  if (ipFamily === 4) {
    if (isBlockedIPv4(hostname, allowRanges)) {
      throw toolError(
        'web_fetch',
        'WEB_BLOCKED_URL',
        suggestAllowRanges(`Blocked internal IP: ${hostname}`, allowRanges),
        'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
      )
    }
    return url
  }
  if (ipFamily === 6) {
    if (isBlockedIPv6(hostname, allowRanges)) {
      throw toolError(
        'web_fetch',
        'WEB_BLOCKED_URL',
        suggestAllowRanges(`Blocked internal IP: ${hostname}`, allowRanges),
        'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
      )
    }
    return url
  }
  // Domain — DNS preflight (skip when trustEnvProxy=true so dev proxies work).
  if (!options.ssrf.trustEnvProxy) {
    let addrs
    try {
      addrs = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch (e) {
      throw toolError(
        'web_fetch',
        'WEB_BLOCKED_URL',
        `DNS lookup failed for ${hostname}: ${e.message || e}`,
        'verify the hostname is reachable and your DNS resolver works; if this is a private host, add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
      )
    }
    if (!addrs || addrs.length === 0) {
      throw toolError(
        'web_fetch',
        'WEB_BLOCKED_URL',
        `DNS lookup returned no records for ${hostname}`,
        'check the hostname is correct; the domain may not exist',
      )
    }
    for (const a of addrs) {
      if (a.family === 4 && isBlockedIPv4(a.address, allowRanges)) {
        throw toolError(
          'web_fetch',
          'WEB_BLOCKED_URL',
          suggestAllowRanges(`DNS resolved ${hostname} to blocked IP ${a.address}`, allowRanges),
          'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
        )
      }
      if (a.family === 6 && isBlockedIPv6(a.address, allowRanges)) {
        throw toolError(
          'web_fetch',
          'WEB_BLOCKED_URL',
          suggestAllowRanges(`DNS resolved ${hostname} to blocked IP ${a.address}`, allowRanges),
          'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)',
        )
      }
    }
  }
  return url
}

function suggestAllowRanges(msg, allowRanges) {
  const arr = Array.isArray(allowRanges) ? allowRanges : []
  const has198 = arr.some((r) => typeof r === 'string' && r.startsWith('198.18.'))
  if (!has198) {
    return msg + ' (If that matches your TUN/fake-IP proxy, configure ssrf.allowRanges with ["198.18.0.0/15"])'
  }
  return msg
}

export function makeFetchError(code, message) {
  // Backward-compat shim: e2e/runner.js and a few legacy call sites import this.
  // New code should call toolError() directly. We preserve the `name='WebError'`
  // for any consumer that does an `err.name === 'WebError'` check.
  const advice = (code === 'WEB_BLOCKED_URL')
    ? 'URL points to a private/reserved IP (SSRF protection); this is intentional — use a public URL, or ask your admin to add the IP via ctx.settings (path: web-access-chain.ssrf.allowRanges)'
    : 'see lib/errors.js for advice templates matching code ' + code
  const e = toolError('web_fetch', code, message, advice)
  e.name = 'WebError'
  return e
}