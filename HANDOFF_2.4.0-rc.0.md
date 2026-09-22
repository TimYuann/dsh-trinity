# Handoff · dsh-trinity 2.4.0-rc.0 / DSH 0.1.7-alpha.1

> Status: implementation complete; static/runtime/GUI/commands pass, but MiniMax M3 blocks the final Agent/tool path before any tool call.
>
> Last updated: 2026-09-22
>
> Repository: `/Users/yuantian/Developer/dsh-web-search-chained`
>
> Branch: `release/2.3.0`
>
> Baseline HEAD: `2762f050fad4f4d62ccf2a0c0b7eea6703871c0c` (`v2.3.0-rc.2`)

## 1. Outcome requested

Upgrade the external DSH plugin from its original 0.1.5-era contract to
`@deepseek-ai/dsh@0.1.7-alpha.1`, repair design defects, redesign the Web settings
GUI, verify existing functionality, and audit gaps against:

- Agent Reach: <https://github.com/Panniantong/Agent-Reach>
- Pi Web Access: <https://github.com/nicobailon/pi-web-access>

The user selected:

- GUI: **Plugins control center** rather than a credentials-only page;
- existing uncommitted command-handler work: **include and validate**;
- validation: **static + isolated runtime/browser**;
- real browser: **Ego Lite**;
- test profile: `dev-trinity`, port `4601` only;
- test model: **`minimax-cn/MiniMax-M3` only**;
- real provider credentials: Exa and AnySearch may be used, but never printed;
- stable public test targets only.

Do not touch the existing `web` profile, `dev` profile, port 4599, or their
history. Another session owns `dev-orchestra:4600`.

## 2. Current repository state

The canonical implementation state is the local upgrade commit containing this
document; use `git log --oneline -1 -- HANDOFF_2.4.0-rc.0.md` to resolve it after
checkout. Before that commit, pre-existing command changes were user-owned and
were explicitly accepted into the upgrade scope.

Files included in the upgrade commit:

```text
HANDOFF_2.4.0-rc.0.md
README.md
lib/client.js
lib/commands/invocation.js
lib/commands/webcache.js
lib/commands/webdoctor-keys.js
lib/commands/webdoctor.js
lib/index.js
lib/providers/provider-metadata.js
package.json
pnpm-lock.yaml
scripts/sync-provider-client.mjs
test/commands/command-handlers.test.js
test/contract/dsh-0.1.7-client.test.js
test/contract/provider-client-sync.test.js
test/integration/acceptance-20.test.js
```

`.pi/` remains untracked runtime state and is not part of the commit. `docs/` is
ignored by this repository; the local research artifact below is useful evidence
but does not enter the package or commit unless repository policy is deliberately
changed.

Local research artifact:

- `docs/dsh-0.1.7-alpha.1-upgrade-and-capability-audit.md`

## 3. Implemented changes

### 3.1 Version and target cohort

- Plugin candidate version: `2.4.0-rc.0`
  - `package.json`
  - `lib/index.js`
- `@deepseek-ai/schemastery` aligned from `3.18.1` to `3.18.3`
  - `package.json`
  - `pnpm-lock.yaml`
- `package.json.dsh.client.inject` removed. In DSH 0.1.7 it means client
  package dependencies, not Cordis service keys. The runtime client export still
  declares `slots`, `locale`, `remote`, and `remote.credentials`.

Official evidence:

- DSH manifest types:
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/util/package-manifest/src/types.ts>
- Official live-client fixture:
  <https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-alpha.1/apps/web/tests/fixtures/plugins/fixture-live-client>

### 3.2 Web GUI redesign

`lib/client.js` was migrated from legacy `settings.section` to the DSH 0.1.7
Plugins-page slot:

```text
plugins.row.config
key = dsh-trinity#web-access-chain
```

The new control center provides:

- Providers / Routing / Diagnostics tabs;
- Provider search;
- All / Configured / Needs setup filters;
- self-hosted / automatic / explicit-only grouping;
- collapsed editors so 25 secret inputs are not mounted simultaneously;
- human display names sourced from canonical provider metadata;
- credential status refresh explicitly labelled as metadata refresh, not a
  provider network test;
- responsive desktop/mobile layout;
- CSS and locale lifetime owned through `ctx.effect`;
- summary and page views for the Plugins row.

Secret invariants:

- stored credential values are never returned by `describe()`;
- input is cleared immediately after save;
- `last4` is browser-session React state only;
- clear requires confirmation;
- no private HTTP or Remote namespace was added;
- no browser cookies are read or migrated.

Files:

- `lib/client.js`
- `lib/providers/provider-metadata.js`
- `scripts/sync-provider-client.mjs`
- `test/contract/provider-client-sync.test.js`
- `test/contract/dsh-0.1.7-client.test.js`
- `README.md`

Official Plugin Manager contract:

- <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/ui-plugin-manager/README.md>

### 3.3 Slash-command root fixes

Original defect: `/webdoctor`, `/webcache`, and `/webdoctor-keys` had structured
`execute()` functions but did not satisfy DSH command registration/execution.
The approved worktree repair added:

- shared `lib/commands/invocation.js`;
- `handler(invocation)` adapters;
- discriminated `CommandResult` output;
- `recordInput: false` for `/webdoctor-keys` so a `set` tail never enters
  durable `command/run` events;
- regression coverage in `test/commands/command-handlers.test.js`.

A real Ego Lite test then found a second 0.1.7 defect: command definitions lacked
`input.hint`, so the Web composer accepted only bare commands and sent trailing
arguments as ordinary model messages.

The fix adds:

- `/webdoctor`: `input: { hint: '[--active]' }`
- `/webcache`: `input: { hint: '[list | get <cacheRef> | purge <cacheRef>]' }`
- `/webdoctor-keys`: a non-empty status/list/set/clear/test/help hint while
  retaining `recordInput: false`

Feedback loop:

1. RED: `node --test test/commands/command-handlers.test.js`
   - 11 passed, 1 failed exactly on missing `/webdoctor` input metadata.
2. GREEN after the fix:
   - 12/12 focused command tests;
   - 374/374 full tests.
3. Real Ego durable events proved:
   - `/webdoctor --active` produced `command/run args=" --active"` and success;
   - Exa active probe was healthy;
   - key status/test commands succeeded while secret-bearing arguments remained
     absent because `recordInput:false`;
   - `/webcache list` produced `command/run args=" list"`.

Official DSH command reference:

- installed package `@deepseek-ai/dsh-commands@0.1.7-alpha.1`
- README contract: optional `input: { hint }` advertises free-form input to UIs.

### 3.4 Tool contract assessment

Luna initially suspected the seven tool definitions needed a 0.1.7 rewrite.
Parent verification showed the local `lib/schema/define-tool.js` already emits:

```text
output: { schema, render, presentationMeta? }
execute(args, ToolRunContext) -> canonical value
```

This matches the installed target `dsh-tools` declaration. No broad tool rewrite
was made. The final runtime attempt was blocked by MiniMax M3 transport before
any tool call, so the tool contract has static/host-shape evidence but not a
completed model-to-tool end-to-end run on the required model.

## 4. Verification completed

### 4.1 Baseline before implementation

Passed:

- `pnpm test`
- `pnpm run lint:no-llm-in-providers`
- `pnpm run check:no-llm-in-providers`
- `pnpm run check:provider-client-sync`

### 4.2 Static and package gates after implementation

Reports:

- `/tmp/dsh-trinity-sol-med-command-green.md`
- `/tmp/dsh-trinity-sol-med-final-gate.md`

Passed:

- command tests: 12/12;
- target contract/integration subset: 60/60;
- full suite: 374/374;
- no-LLM gates;
- provider/client sync;
- package creation and inspection.

Artifact:

```text
/tmp/dsh-trinity-validation-final/dsh-trinity-2.4.0-rc.0.tgz
SHA-256 a7029612923a22d838591f855572b759dfafdca20aade98240d0a94ef436b171
```

Package includes `lib/client.js`, `lib/commands/invocation.js`,
`cordis.patch.yml`, and `README.md`; excludes `.pi`, tests, docs, and
`lib/_deferred`.

### 4.3 DSH 0.1.7 runtime/GUI acceptance

Report: `/tmp/dsh-trinity-sol-xhigh-runtime.md`

Passed on `dev-trinity:4601`:

- profile install resolves `dsh-trinity@2.4.0-rc.0`;
- composition selects `web-access-chain-search/fetch`;
- `web-search-deepseek` disabled;
- `tool-web` enabled;
- cold start;
- Host boot manifest advertises the client artifact;
- fetched artifact contains the expected module registration and row slot;
- Plugins navigation and control-center mount;
- desktop/mobile responsive layout;
- bare `/webdoctor` command;
- no repository mutation.

Screenshot from that pass:

- `/tmp/dsh-trinity-control-center.png`

### 4.4 Ego Lite real-user testing

First report: `/tmp/dsh-trinity-sol-xhigh-ego-real.md`

That run found the missing `input.hint` root cause. After the fix, the original
command symptom was verified resolved with durable events.

Final report: `/tmp/dsh-trinity-sol-xhigh-ego-retest-fallback.md`

Environment:

- run id: `5d4f07e6-1a66-41e8-9b3d-61386f477955`;
- tester: `openai-codex/gpt-5.6-sol:xhigh`;
- browser: Ego Lite TaskSpace 48, one page, cleanly finished once;
- DSH Session: `session-4223da17-fb25-4f86-a380-b31b2db1dd9c`;
- model: `minimax-cn/MiniMax-M3` only;
- dedicated profile/port: `dev-trinity:4601`;
- test listener PID 33334, stopped; port 4601 confirmed free.

Result: **failed only at the required model transport gate**.

Two bounded turns asked MiniMax M3 to call `web_search_ex` with query
`IANA Example Domain`, routing `exa`, and `maxResults=3`. Each turn produced five
durable `llm/retry` events and then failed with:

```text
TRANSPORT: Anthropic stream ended without a stop reason
```

Durable counts:

- turns: 2;
- `llm/retry`: 10;
- `tool/call`: 0;
- `tool/result`: 0;
- Exa calls: 0;
- AnySearch calls: 0;
- other paid-provider calls: 0.

The failure occurs before this plugin receives any call. The child correctly did
not switch models, call provider APIs directly, use page evaluation, or pretend
that model text was tool evidence. Therefore the following stable fixtures were
blocked rather than failed by their target sites:

- `https://example.com/`;
- `https://github.com/deepseek-ai/deepseek-harness`;
- `https://hnrss.org/frontpage`;
- `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`;
- Exa query `IANA Example Domain`;
- AnySearch query `DeepSeek Harness GitHub repository`.

Safety/cleanup passed:

- screenshot: `/tmp/dsh-trinity-minimax-m3-blocked.png`;
- redacted session summary:
  `/tmp/dsh-trinity-minimax-session-summary-redacted.json`;
- credential-pattern scan: zero matches;
- Ego page events: none;
- Host warnings/errors: none;
- Git status, diff stat, HEAD, and tracked diff digest were unchanged;
- TaskSpace and listener cleanup completed without touching other processes.

Do not mark Exa/AnySearch search, fetch adapters, or
`source_check -> search_content` as passed until the MiniMax Anthropic-compatible
stream emits a valid terminal stop and the same stable matrix is rerun.

## 5. DSH host/settings migration facts

Another session owns the global DSH/orchestra migration:

- session: `orchestra-update-0922`
- repository: `/Users/yuantian/Developer/orchestra-dsh`
- assigned profile: `dev-orchestra:4600`
- existing `web:4599` remains untouched.

Global DSH was upgraded to `0.1.7-alpha.1` by that session. It did not restart
4599.

The 0.1.7 settings importer is global-once/profile-local:

1. it reads `$DSH_HOME/settings.yaml`;
2. renames it to `settings.yaml.imported` before writing;
3. writes accepted sections into the currently active profile;
4. rejected sections remain only in `.imported`.

Read-only structural comparison showed that `dev-trinity/cordis.patch.yml`
matches the legacy document for:

- `ui-onboarding -> ui-settings-general`;
- `ui-theme`;
- `llm-pi-ai`;
- `ui-conversation`;
- `agent-default-model` provider/model (legacy reasoning effort did not persist).

`web-search-deepseek` existed in legacy shape but did not enter dev-trinity,
consistent with the plugin composition disabling that row.

The user later explicitly authorized migration of all credentials. Coordination
instructions sent to orchestra:

- prefer the native DSH credential store and refs;
- do not print values;
- migrate actual values only when still stranded in legacy/profile secret fields;
- report only counts, configured/source/writable state, and source category;
- do not restore `.imported` to the global legacy filename;
- future profiles require explicit profile-local non-secret config migration.

## 6. Upstream feature-gap audit

### Pi Web Access 0.30.0

High-value future candidates:

- direct adapters: SerpApi, Serply, Mistral, XCrawl;
- optional self-hosted fetch: Crawl4AI;
- separate, guarded GitHub clone tool.

Do not directly copy Pi-specific auth reuse (Codex, Kimi Code Plan) or Gemini
browser-cookie behavior into DSH.

### Agent Reach 1.5.0

Missing social/channel surface includes Twitter/X, Reddit, XiaoHongShu,
Bilibili, Facebook, Instagram, LinkedIn, Boss, V2EX, Xiaoyuzhou, and Xueqiu.

Recommended future module:

```text
small read/search/inspect channel interface
    -> optional agent-reach CLI adapter
    -> optional OpenCLI adapter
    -> zero-config public adapters
```

Do not copy its installer or cookie handling into the core plugin. Social
integration must remain read-only, explicitly enabled, and unavailable when its
backend is unhealthy.

No upstream capabilities were implemented in this upgrade; only the audit and
prioritization were completed.

## 7. Known residuals / next actions

1. The only required test blocker is outside this plugin: diagnose the
   MiniMax-M3 Anthropic-compatible stream so it emits a terminal stop reason.
   After repair, rerun the same Ego Lite matrix on MiniMax M3 only; do not use a
   different model to declare this gate passed.
2. The plugin candidate can be reviewed/installed for its verified 0.1.7
   composition, GUI, commands, package, and static behavior, but release notes
   must preserve the model/tool-path limitation until rerun.
3. Rollback:
   - source rollback is `git revert <upgrade-commit>` after the local commit;
   - profile rollback is limited to `dev-trinity` and the prior package artifact;
   - never reset/clean unrelated work or restore global legacy settings.
4. Remaining design issue not fixed here: Host subprocess support exists in
   `lib/util/subprocess.js`, but several callsites pass `undefined` and therefore
   always use Node child-process fallback. Fix only after a separate target-policy
   investigation.
5. npm two-version materialization is blocked because
   `@deepseek-ai/dsh@0.1.5-rc.2` references unpublished
   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`.
   Full log: `/tmp/dsh-trinity-audit-full.log`. The tag/source audit remains the
   authoritative corridor evidence.
6. `docs/dsh-0.1.7-alpha.1-upgrade-and-capability-audit.md` is ignored by the
   current repository policy. Preserve it locally or deliberately change docs
   tracking in a separate decision; do not assume it is included in the commit.

## 8. Important evidence paths

```text
/tmp/dsh-trinity-sol-med-static-rerun.md
/tmp/dsh-trinity-sol-med-command-green.md
/tmp/dsh-trinity-sol-med-final-gate.md
/tmp/dsh-trinity-sol-xhigh-runtime.md
/tmp/dsh-trinity-sol-xhigh-ego-real.md
/tmp/dsh-trinity-command-input-red.md
/tmp/dsh-trinity-control-center.png
/tmp/dsh-trinity-ego-control-center-fixed.png
/tmp/dsh-trinity-sol-xhigh-ego-retest-fallback.md
/tmp/dsh-trinity-minimax-session-summary-redacted.json
/tmp/dsh-trinity-minimax-retest-4601-sanitized.log
/tmp/dsh-trinity-minimax-m3-blocked.png
/tmp/dsh-trinity-validation-final/dsh-trinity-2.4.0-rc.0.tgz
/tmp/dsh-trinity-audit-full.log
HANDOFF_2.4.0-rc.0.md
```

Subagent research reports:

```text
/tmp/dsh-web-search-chained-terra-local-audit.md
/tmp/dsh-web-search-chained-luna-official-audit.md
```

Do not quote session JSONL or credentials without redaction.

## 9. Suggested skills for the next agent

Load these skills before continuing:

- `plugin-upgrade` — target-version migration and confirmation boundaries;
- `plugin-test` — exact-version static/runtime/artifact validation;
- `diagnosing-bugs` — if any Ego/command/tool regression remains;
- `ego-browser` — real browser work; one TaskSpace per goal;
- `neat-freak` — finish README/docs reconciliation and remove stale claims;
- `agent-reach` — only if continuing upstream internet/channel research;
- `research` — when turning primary-source findings into a reusable artifact;
- `handoff` — if transferring again.

Subagent policy from the owner:

- main task/source edits are done by the parent agent;
- subagents are used for investigation, evidence, research, and tests;
- only `openai-codex/gpt-5.6-sol:medium` and
  `openai-codex/gpt-5.6-sol:xhigh` may be used for future subagent dispatches;
- WebSocket/connection errors should be continued in the same protocol after
  verifying repository state.
