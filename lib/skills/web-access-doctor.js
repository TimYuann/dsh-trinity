// lib/skills/web-access-doctor.js — web-access-doctor Skill (SPEC §I.6).
//
// Same SkillRegistration contract as web-access.js: `body`/`triggers` are
// not seam fields — the seam requires name/description/source/content
// (invocation optional). Failure triage after WEB_PROVIDER_ERROR /
// WEB_FETCH_FAILED / WEB_SEARCH_CHAIN_EXHAUSTED.

export const SKILL_NAME = 'web-access-doctor'

/**
 * @param {any} _ctx
 * @param {any} skills
 */
export function registerWebAccessDoctorSkill(_ctx, skills) {
  if (!skills || typeof skills.register !== 'function') return () => {}
  return skills.register({
    name: SKILL_NAME,
    description: 'Failure triage after web search / fetch error responses — diagnose providers, credentials, proxy, identity.',
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
    content: `When \`web_search\` or \`web_fetch\` returns \`WEB_PROVIDER_ERROR\`,
\`WEB_FETCH_FAILED\`, or \`WEB_SEARCH_CHAIN_EXHAUSTED\`, use this skill:

1. Call \`web_doctor()\` (passive mode by default). Inspect:
   - \`providers[]\`: which providers have \`lastErrorClass\` of \`quota\`, \`auth\`, or \`network\`?
   - \`cache\`: is the cache populated?
   - \`identity\`: are the sessionId / profileId fields populated?
2. Based on the doctor output, choose:
   - If quotaCooldown: tell the user to wait, or switch provider.
   - If auth: tell the user to refresh credentials via \`/webdoctor-keys set <provider> <key>\`.
   - If network: ask the user to verify connectivity or set a proxy.
   - If invalid-response: retry with a different provider.
3. If the structured \`WEB_SEARCH_CHAIN_EXHAUSTED\` failure surfaced
   \`attempts[]\`, summarise the per-provider error classes to the user
   (NO key prefixes or fragments — the redaction path is exercised by
   \`test/key-redact.test.js\`).
4. After diagnosis, either retry with a pin (\`web_search_ex({ routing: 'brave' })\`)
   or stop and ask the user how to proceed.`,
  })
}
