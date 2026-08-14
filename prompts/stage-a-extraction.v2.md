# Stage A — Extraction (v2)

Adds `seniority` and `experienceYears` to v1's requirement list. Both are
fields on `Posting`, populated during extraction and visible to scoring, not
only to the pre-filter's title pattern (`05-domain-model.md`) — "Analista de
Sistemas" is sometimes an internship, and "Estágio" sometimes demands three
years of experience.

`promptVersion` for this file: `a-v2`. Supersedes `a-v1` (a structural
output-shape change, not a wording tweak — array became object) — `a-v1` is
kept, unedited, as the immutable record of what came before it, the same
discipline `docs/03-technical-decisions.md` applies to ADRs.

## Template

Placeholders `{{POSTING_TITLE}}` and `{{POSTING_DESCRIPTION}}` are substituted
by `src/scoring/infrastructure/prompts.ts` before the prompt is sent.

```
You are extracting structured information from a Brazilian internship
posting. Read only the posting text below — do not infer anything the text
does not state, and do not guess what a typical posting of this kind usually
asks for.

1. For every distinct requirement the posting declares, output an object
   with:
   - "text": the requirement, written close to how the posting states it
   - "category": a short label grouping similar requirements, e.g.
     "language", "tooling", "education", "soft_skill", "availability"
   - "weight": one of "blocking", "mandatory", "desirable"
     - "blocking": an explicit knockout condition (e.g. "must be enrolled
       from the 3rd period onward", "must live in Rio de Janeiro")
     - "mandatory": stated as required, but not phrased as a knockout
     - "desirable": stated as a plus, nice-to-have, or preferred

   If the posting states no clear requirements at all, output an empty
   array — do not invent requirements to fill it.

2. Separately, read the posting's stated seniority level, if any:
   - "seniority": one of "internship", "trainee", "junior", "mid", "senior",
     or null if the posting does not state one clearly. Judge this from what
     the posting actually says it wants (years of experience implied,
     explicit level words), not from the job title alone — a title can say
     "Estágio" while the body asks for years of professional experience.
   - "experienceYears": the number of years of experience the posting
     states as a requirement, or null if none is stated. A number, not a
     range description — if the posting gives a range, use the minimum.

Respond with only this JSON object, no other text:

{
  "requirements": [
    { "text": "...", "category": "...", "weight": "mandatory" }
  ],
  "seniority": "internship",
  "experienceYears": null
}

Posting title:
{{POSTING_TITLE}}

Posting description:
{{POSTING_DESCRIPTION}}
```
