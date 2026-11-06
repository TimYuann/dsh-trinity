// lib/credentials/gh-env.js — the environment the `gh` CLI needs.
//
// The host subprocess seam scrubs credential-shaped environment entries
// from the inherited base (`SENSITIVE_ENV_PATTERN` in
// @deepseek-ai/dsh-subprocess matches KEY / PASSWORD / SECRET / TOKEN),
// so a `GH_TOKEN` that only exists in the host process would never reach
// the child. The seam's own contract says a string value in the caller's
// `env` is a DELIBERATE opt-in and survives the scrub — so the token is
// forwarded explicitly, and nothing else from the environment is.
//
// Nothing here ever prints or logs a token value.

/**
 * The `gh` CLI's own config file is its primary credential source; these
 * environment variables are the opt-in override.
 */
const GH_TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN']

/**
 * Build the explicit environment for a `gh` invocation.
 *
 * @param {NodeJS.ProcessEnv} [source] — the environment to read from
 * @returns {Record<string, string> | undefined} undefined when no token is set
 */
export function ghEnv(source = process.env) {
  const env = {}
  for (const key of GH_TOKEN_VARS) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return Object.keys(env).length > 0 ? env : undefined
}
