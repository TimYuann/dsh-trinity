// lib/gemini-model.js — the single default Gemini model id for every
// Google-backed call in this plugin (search grounding, PDF extract,
// video extract).
//
// WHY AN ALIAS RATHER THAN A PINNED MODEL (2026-09-22):
//
//   The previous default was the pinned id `gemini-2.5-flash`. Google
//   retired it for new users, so every request returned HTTP 404
//   "This model ... is no longer available to new users" while the model
//   still appeared in the models list. Concretely:
//
//     POST /v1beta/models/gemini-2.5-flash:generateContent -> 404
//     POST /v1beta/models/gemini-flash-latest:generateContent -> 200
//
//   A 404 does not match any pattern in classifyError(), so it was
//   classed `unknown`; the credential pool then walked its empty slots
//   (MISSING_API_KEY -> class `credential`) and the chain reported the
//   LAST attempt, surfacing a perfectly valid key as
//   "provider gemini failed: credential".
//
//   `gemini-flash-latest` is Google's own tracking alias, so it follows
//   the current generation instead of going stale on a retirement. Pin a
//   specific id only through the per-profile setting when reproducibility
//   matters more than staying live.
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
