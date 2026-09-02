# Deferred v1 tools (R1 — Commit 3 territory)

These three v1 tool modules are NOT registered by `lib/index.js` and must
not be imported anywhere in v2.0 R1. They are kept here only as
historical reference for the diff vs DSH Trinity 前身 `dsh-web-search-chained` v1.0.0.

## Why they are deferred

SPEC §III.2 Commit 3 will:

1. Replace each adapter with the cheap variant (`lib/adapters/{github,
   youtube, rss, pdf}.js`).
2. Wire the corresponding specialised Tool gated by `tools.*.enabled`
   in `cordis.patch.yml`.
3. Replace the v1 `gh api` / `yt-dlp` / `unpdf` shell calls with
   thin adapter invokes.

Until then, **the public Tool surface is**:
- `web_search_ex` (DSH built-in routed via `web-access-chain-search`)
- `web_fetch` (DSH built-in routed via `web-access-chain-fetch`)
- `web_search_ex`, `search_content`, `source_check`, `web_doctor` (this plugin)

## Files

- `github-extract.js` — replaced by `lib/adapters/github.js` (cheap README + tree + PR/Issue summary via `gh api`)
- `pdf-extract.js` — replaced by `lib/adapters/pdf.js` (unpdf → markdown) + `lib/tools/pdf-extract.js`
- `video-extract.js` — replaced by `lib/adapters/youtube.js` (yt-dlp metadata + transcript) + `lib/tools/video-extract.js`

## Audit trail

If `cordis.patch.yml` is hand-edited to flip any of:
- `web-access-chain.tools.githubPrIssue.enabled = true`
- `web-access-chain.tools.videoExtract.enabled = true`
- `web-access-chain.tools.pdfExtract.enabled = true`

the registered Tool will be the v1 heavy variant, NOT the v2.0 cheap
adapter path. SPEC §III.3 "Tool gating is independent of adapter gating"
does NOT hold until Commit 3 lands.
