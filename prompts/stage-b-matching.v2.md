# Stage B — Matching (v2)

Same judgment as `b-v1` — for one requirement at a time, whether the profile
meets it, with a mandatory verbatim evidence quote (`docs/04-scoring-model.md`,
ADR-005). `b-v2` only reorders the template: every static block (instructions,
decision criteria, output format, and — critically — the full candidate
evidence list) now comes first, and the one block that changes on every call
(`{{REQUIREMENT_TEXT}}`/`CATEGORY`/`WEIGHT`) comes last.

That reordering is the whole point of this version: prompt caching (OpenRouter
via DeepSeek, ADR-013) matches a **prefix**, not the prompt as a whole. Under
`b-v1`, the requirement — the part that is different on every single
call — came before the evidence block, so no meaningful prefix was ever shared
across calls. Stage B runs once per requirement, many times per posting, so
that block is the highest-volume repeated content in the whole pipeline.
Moving it to the end lets everything before it — often the largest part of the
prompt — be served from cache on the second call onward within a run.

`promptVersion` for this file: `b-v2`. Supersedes `b-v1` (kept, unedited, as
the immutable record of what came before it — see `a-v1`'s note).

## Template

Placeholders `{{REQUIREMENT_TEXT}}`, `{{REQUIREMENT_CATEGORY}}`,
`{{REQUIREMENT_WEIGHT}}` and `{{PROFILE_EVIDENCE}}` are substituted by
`src/scoring/infrastructure/prompts.ts`. `{{PROFILE_EVIDENCE}}` is every
competency's evidence bullets, verbatim, each tagged with which competency it
belongs to — the only text a quote may legally come from.

```
You are judging whether a candidate's profile evidence meets ONE stated
requirement from a job posting. You are not evaluating the candidate overall
and you are not asked for an opinion — only whether this one requirement is
supported by the evidence below.

Candidate profile evidence (verbatim; nothing outside this list may be
quoted):
{{PROFILE_EVIDENCE}}

Decide:
- "met": the evidence clearly and directly supports the requirement
- "partial": the evidence is related but does not fully cover the
  requirement
- "not_met": no evidence in the list supports the requirement

If you answer "met" or "partial", you MUST quote, character for character,
one sentence from the evidence list above as "evidence". Do not paraphrase,
combine, or summarize — copy it exactly. If no sentence in the list actually
supports your answer, answer "not_met" and set "evidence" to null. A "met" or
"partial" with no genuine supporting quote is a wrong answer, not a
convenience.

Respond with only this JSON object, no other text:

{ "status": "met", "evidence": "exact quote from the list, or null" }

Now judge this requirement:

Requirement: {{REQUIREMENT_TEXT}}
Category: {{REQUIREMENT_CATEGORY}}
Weight: {{REQUIREMENT_WEIGHT}}
```
