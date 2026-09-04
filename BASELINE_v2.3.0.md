# DSH Trinity 2.3.0 Baseline Record

Captured before any 2.3.0 contract-closure change. All numbers reproducible from
the SHA below.

```text
base SHA:  1274fb4b43cc5f615cf3cd8d4098a1d739ab7c5e
package:   dsh-trinity@2.2.3
target DSH: 0.1.2-rc.1
branch:    release/2.3.0
```

## Tooling

```text
node     v22.22.2
pnpm     11.24.0
git      2.x
```

## Repository tree sanity

```bash
git ls-tree -r --name-only HEAD | grep -E "^(bin|docs|scripts|lib)/" | head -30
# bin/lint-no-llm-in-providers.js  — exists, real
# bin/sync-bundle.js              — exists, real
# docs/dsh-alpha4-compatibility-plan.md   — exists, real
# docs/routing-integrity-investigation.md — exists, real
# scripts/                         — does not exist (no scripts/ at commit 1274fb4)
# .github/                         — does not exist
```

`package.json` scripts already reference the real files in `bin/`; no broken
script claims at the recorded baseline. README does mention the two real docs
in `docs/`.

## Baseline test result

```bash
pnpm test
# tests 299
# pass  296
# fail  3   (dev-profile composition integration, requires `dsh --profile dev`)
# duration ~11s
```

The 3 failing tests are integration tests in
`test/integration/dev-alpha4-composition.test.js` that shell out to
`dsh --dump-config --profile dev`. Those failures are environment-driven
(not code-driven) and were not introduced by the reviewed defects; per
Section 6.2 they will be re-evaluated against a clean DSH `0.1.2-rc.1`
profile at the end of the repair.

## Frozen records for downstream commits

### Pinned routing regression (review P0 #1)

Existing entries that mask the bug:

```js
// test/chained.search.test.js (around line N) — many tests pass routing as
// a pre-normalised value into chainedSearch directly, bypassing the
// web_search_ex wrapper.
```

### Live settings regression (review P1 #4)

```text
lib/settings/register.js   — register() return captured as raw disposer;
                             SettingsScope.watch() never attached.
lib/util/gated-register.js  — listens to settingsSvc.on('change'); this is
                             not the authoritative SettingsScope.watch().
```

### Safe fetch regression (review P0 #2)

```text
lib/providers/fetch/chained-fetch.js:87
  fetch(headUrl, { method: 'HEAD', redirect: 'follow', signal })
```

### Source-check regression (review P1 #6)

```text
lib/source-check/score.js   — tokenizer: [a-z0-9] only.
lib/source-check/score.js   — sentence split: .?! only.
lib/tools/source-check.js   — neutral passage coerced to supporting.
```

### Cache regression (review P1 #10)

```text
lib/cache/index.js          — MAX_ENTRIES hard-coded to 128
lib/cache/index.js          — ttlMs defaults to 3 600 000 when input.ttlMs is 0
```

## Stop-condition audit (Section 9)

| # | Stop condition | Current state |
|---|---|---|
| 1 | base SHA differs | matches baseline SHA |
| 2 | DSH seam differs | to be re-verified against `0.1.2-rc.1` in Section 6.2 |
| 3 | DNS pinning cannot govern fetch | not yet attempted (commit 3) |
| 4 | provider cannot honor abort | not yet attempted (commit 3) |
| 5 | schema field cannot be tied | not yet attempted (commit 5) |
| 6 | packed artifact differs | not yet attempted (commit 6) |
| 7 | clean profile cannot reproduce | not yet attempted (commit 6) |

No stop condition is currently triggered.
