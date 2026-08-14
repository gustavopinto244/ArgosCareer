# Stage B — Matching (v1)

For one requirement at a time, judges whether the profile meets it — with a
mandatory verbatim evidence quote (`docs/04-scoring-model.md`, ADR-005). Run
once per requirement, not once per posting: a narrow, checkable judgment is
what a small model is good at; a holistic one is not.

`promptVersion` for this file: `b-v1`. A wording change is a new file (`b-v2`),
not an edit here — see `a-v1`'s note on why.

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

Requirement: {{REQUIREMENT_TEXT}}
Category: {{REQUIREMENT_CATEGORY}}
Weight: {{REQUIREMENT_WEIGHT}}

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
```
