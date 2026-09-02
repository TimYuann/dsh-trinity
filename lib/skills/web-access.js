// lib/skills/web-access.js — web-access Skill (SPEC §I.6).
//
// The registered object MUST satisfy the DSH skill seam's SkillRegistration
// contract (verified against @deepseek-ai/dsh-skill/lib/types/index.d.ts):
//   name (kebab-case), description, source, content, invocation?
//   (provider? — omitted here so the registry-owned runtime provider wins).
// `body` / `triggers` are NOT seam fields; they made registration silently
// fail (TypeError: loaded skill source must be a string) since v2.0.

export const SKILL_NAME = 'web-access'

/**
 * @param {any} _ctx
 * @param {any} skills
 */
export function registerWebAccessSkill(_ctx, skills) {
  if (!skills || typeof skills.register !== 'function') return () => {}
  return skills.register({
    name: SKILL_NAME,
    description: 'Advanced web research — multi-Provider comparison, multi-query fan-out, cached-content retrieval, source verification.',
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
    content: `Use this skill when the user needs a research capability beyond the built-in
\`web_search\` / \`web_fetch\`:

- Multi-Provider comparison or aggregate: \`web_search_ex({ routing: 'aggregate', query: '...' })\`
- Multi-query fan-out in one call: \`web_search_ex({ queries: ['q1', 'q2', 'q3'] })\`
- Pinning a specific provider: \`web_search_ex({ routing: 'brave', query: '...' })\`
- AI-synthesised answer from sources: \`web_search_ex({ output: 'answer', query: '...' })\`
- Reading back a source_check evidence snapshot: \`search_content({ cacheRef: '<ref>', findText: 'passage' })\` (cacheRefs come from source_check's evidenceSnapshotRefs — web_search_ex / web_fetch do not produce them)
- Verifying a claim with assessment + evidence snapshot refs: \`source_check({ claim: '...' })\`

Do NOT use this skill for ordinary "search the web" or "open this URL" — those
use the built-in \`web_search\` and \`web_fetch\` directly.`,
  })
}
