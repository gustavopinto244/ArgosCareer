# Stage A — Extraction (v1)

Reads a posting's title and description, returns the requirements it declares
as structured JSON. Never asked for a score, a match, or an opinion — only
what the posting itself states (`docs/04-scoring-model.md`).

`promptVersion` for this file: `a-v1`. Bumping the wording below to `a-v2`
means writing a new file, not editing this one — old cached extractions
(keyed by `promptVersion`, ADR-007) stay comparable against the new ones.

## Template

Placeholders `{{POSTING_TITLE}}` and `{{POSTING_DESCRIPTION}}` are substituted
by `src/scoring/infrastructure/prompts.ts` before the prompt is sent.

```
You are extracting structured requirements from a Brazilian internship
posting. Read only the posting text below — do not infer anything the text
does not state, and do not guess what a typical posting of this kind usually
asks for.

For every distinct requirement the posting declares, output an object with:
- "text": the requirement, written close to how the posting states it
- "category": a short label grouping similar requirements, e.g. "language",
  "tooling", "education", "soft_skill", "availability"
- "weight": one of "blocking", "mandatory", "desirable"
  - "blocking": an explicit knockout condition (e.g. "must be enrolled from
    the 3rd period onward", "must live in Rio de Janeiro")
  - "mandatory": stated as required, but not phrased as a knockout
  - "desirable": stated as a plus, nice-to-have, or preferred

If the posting states no clear requirements at all, output an empty array —
do not invent requirements to fill it.

Respond with only a JSON array, no other text:

[
  { "text": "...", "category": "...", "weight": "mandatory" }
]

Posting title:
{{POSTING_TITLE}}

Posting description:
{{POSTING_DESCRIPTION}}
```
