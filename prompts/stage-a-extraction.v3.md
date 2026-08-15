# Stage A — Extraction (v3)

Adds `verifiable` to every requirement. Same output shape as `a-v2`
otherwise — same `seniority`, same `experienceYears`, same requirement
fields.

## Why this field exists

Measured against the first 16 hand-labelled postings, **28% of all
`mandatory` and `blocking` requirements were unfalsifiable self-description**:
"dinamismo", "proatividade", "boa capacidade de comunicação oral e escrita",
"facilidade para trabalhar em equipe", "vontade de aprender".

No portfolio can evidence those, so stage B correctly answered `not_met` on
every one, and stage C counted each as a zero in `mandatoryCoverage`. The
effect was strongest on exactly the postings judged best by hand: the DevOps
internship scored 40.1 against a hand score of 100 with 5 of its 10 mandatory
requirements being traits; the Smarthis programme scored 21.1 against 100
with 3 of 6.

The score answers "does this profile meet what the posting declares". A trait
requirement has no discriminating power — every candidate asserts it and none
can prove it — so counting it as a failure measures whether a CV happens to
contain the word "proativo", which is not the question. ADR-015 records the
decision; stage C excludes non-verifiable requirements from coverage rather
than counting them as met, because "no information" is not "satisfied".

`promptVersion` for this file: `a-v3`. Supersedes `a-v2`, which is kept
unedited as the record of what came before it.

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
   - "verifiable": true or false — whether a candidate could demonstrate
     this with evidence outside their own assertion.
     - true: anything checkable against an artifact or a fact — a degree or
       enrolment, a period or graduation date, a language level, a tool or
       technology used, a project built, a certificate, a location,
       an availability or schedule, a legal requirement, a vaccination.
     - false: a personal quality, attitude or disposition that exists only
       as a claim about oneself — "proatividade", "dinamismo", "boa
       comunicação", "trabalho em equipe", "organização", "curiosidade",
       "vontade de aprender", "atenção aos detalhes", "perfil analítico".
     - When a requirement mixes both, judge it by the part that could be
       checked: "boa comunicação escrita em inglês" is verifiable, because
       the English level is.
     - When genuinely unsure, answer true. Marking something unverifiable
       removes it from scoring entirely, so the cautious answer is to keep
       it in.

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
    {
      "text": "...",
      "category": "...",
      "weight": "mandatory",
      "verifiable": true
    }
  ],
  "seniority": "internship",
  "experienceYears": null
}

Posting title:
{{POSTING_TITLE}}

Posting description:
{{POSTING_DESCRIPTION}}
```
