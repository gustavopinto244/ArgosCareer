# ADR-036 — Bound and sanitize what reaches the model, and what the model's output reaches next

## Status

Accepted

## Date

2026-08-17

## Context

`docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` (AC-017, OPEN) found
that nothing bounded the size of what Stage A sends to the model, nor the
size or shape of what the model is allowed to send back:

- A posting's `title`/`description` went into `buildStageAPrompt` verbatim.
  Sólides in particular returns real rich-text markup (`h1`/`h2`/`p`/`strong`/
  `ul`/`li`), so the same visible content could cost a wildly different
  number of prompt characters depending on how verbose the source's HTML
  happened to be — and there was no ceiling on the raw size at all. A
  pathologically large or adversarial description could make a single Stage
  A call arbitrarily expensive, slow, or (per the audit's cost model,
  `POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` §8) blow out the
  per-operation attempt budget ADR-035 established.
- `ExtractionOutputSchema.requirements` was an unbounded array of objects
  whose `text`/`category` fields were themselves unbounded strings. A
  degenerate or adversarial model response could return hundreds of
  requirements, each arbitrarily long, and the schema would accept it.
- Finding PR-010 (same audit, tied explicitly to AC-017 being open) traced
  the consequence one step further: `StageBMatcher` builds its
  `operationLabel` as `` `stage-b:${fingerprint}:${requirement.text}` `` —
  and `requirement.text` originates entirely in the untrusted posting
  description. That unbounded, unescaped string is interpolated straight
  into every retry/failure log line (`llm-output.ts`) — attacker-influenced
  text with no bound on length or content reaching a log sink, and one that
  lets a crafted description forge extra log lines via embedded newlines.
  (Note: `docs/08-observability.md` does not currently state an explicit
  "no posting/profile text in logs" policy despite the audit's phrasing —
  `SECURITY.md` only commits to never logging credentials. This ADR treats
  the finding on its own technical merits — unbounded untrusted input
  reaching a log sink — rather than as a violation of a written rule that
  does not exist yet.)

This project has no tokenizer dependency and no plan to add one just for a
size estimate, so any bound here is necessarily a character-count proxy for
a token budget, not an exact one.

## Considered options

### Option A — Only cap the requirement array length

Closes the literal "definir limite de requirements por posting" wording but
leaves every other vector in the audit open: an unbounded description, HTML
markup inflating prompt size unpredictably, unbounded per-requirement text
still able to blow up Stage B's prompt and the PR-010 log injection. Rejected
as incomplete — the branch is titled "bound and sanitize LLM inputs and
outputs", not "cap one array".

### Option B — Add a tokenizer dependency for an exact token budget

Would make the bound precise instead of a character-count proxy. Rejected:
this project deliberately has no tokenizer dependency, adding one is a
disproportionate answer to "prevent a pathological case", and a generous
character ceiling already makes the worst case bounded and measurable, which
is what the finding asks for — not that the bound be exact.

### Option C — Bound and sanitize every point identified above

Strip HTML to plain text before it counts toward any budget or reaches the
prompt (so the bound is not gameable by verbose markup), truncate the
result at a generous, section-aware character ceiling, cap the requirement
array length and each requirement field's length in the output schema, and
sanitize untrusted text before it can reach a log label. Chosen: it closes
every vector the audit actually traced, not just the one with an explicit
acceptance-criterion sentence.

## Decision

**Input side (`src/scoring/domain/html-to-text.ts`,
`src/scoring/domain/text-truncation.ts`, wired in
`StageAExtractor.extract`):**

- `htmlToText` is a small, deterministic, hand-rolled HTML-to-text pass —
  not a general parser, tuned to what job-posting rich text actually
  contains (headings, paragraphs, lists, line breaks, bold/italic, named
  and numeric entities). No third-party dependency, matching this project's
  preference for a small bounded transform over a library (the same
  reasoning ADR-035 used to reject a retry library). Applied to both
  `title` and `description` before anything else touches them.
- `truncateDescription` bounds the normalized text to
  `DEFAULT_MAX_DESCRIPTION_CHARS = 12_000` — measured against Sólides'
  richest fixture (~5KB of real markup) and left deliberately generous.
  Section-aware: accumulates whole paragraphs up to the budget rather than
  cutting mid-paragraph, falling back to a word/grapheme-boundary cut
  (`Intl.Segmenter`) only when a single paragraph alone exceeds it.
- The result is never silent: `TruncationResult.truncated` flows through
  `ExtractionResult.inputTruncated` → `ScoreResult.inputTruncated`
  (`scorer.port.ts`) so a truncated evaluation is a recorded fact, not an
  invisible one — the digest type deliberately does not widen to carry it
  yet (see the docblock on `ScoredPosting` in `digest.ts`), since nothing
  downstream reads it; `executeDeliver` has `result` in scope whenever
  something needs to.
- The content hash, the cache lookup, and the prompt itself all see exactly
  the same normalized-and-bounded text — `inputTruncated` is therefore an
  honest fact about what the model actually received, not a fact about the
  raw posting that could disagree with what got cached or sent.

**Output side (`ExtractionOutputSchema`, `stage-a-extractor.ts`):**

- `requirements` is capped at `DEFAULT_MAX_REQUIREMENTS_PER_POSTING = 40` —
  a real posting extracts to a handful, up to maybe 15; 40 is a safety
  ceiling against a degenerate response, not a realistic count.
- Each requirement's `text` is capped at `MAX_REQUIREMENT_TEXT_CHARS = 500`
  and `category` at `MAX_REQUIREMENT_CATEGORY_CHARS = 100`. Capping the
  array alone leaves each element's size unbounded, which would still let
  one requirement blow up Stage B's per-requirement prompt
  (`REQUIREMENT_TEXT` in `prompts.ts`) and, via PR-010, a log line.
- An over-limit response is not special-cased: it is `invalid_output` like
  any other schema failure, and routes through the existing retry/repair
  budget (ADR-006) and, on exhaustion, into the review section with
  `lowConfidence` — no separate chunking or quarantine path, because the
  path that already exists already does the right thing.

**Log sanitization (`src/scoring/domain/log-label.ts`, wired in
`StageBMatcher`, fixing PR-010):**

- `sanitizeLogLabel` strips C0 control characters (including newlines,
  carriage returns and tabs) and DEL, collapses the resulting whitespace,
  and caps the result at 60 characters with an ellipsis marker. Applied to
  `requirement.text` before it is interpolated into `operationLabel`, so a
  crafted requirement can no longer forge extra log lines via an embedded
  newline or blow past a reasonable label length — a second, independent
  bound at the exact point untrusted text reaches a log line, on top of
  (not instead of) `MAX_REQUIREMENT_TEXT_CHARS` upstream. See ADR-035's
  Amendment 1.

**A bug found while writing this ADR's tests, fixed in the same change:**
`html-to-text.ts`'s original tag-stripping pattern matched anything between
a bare `<` and `>`, including plain text with no markup at all — a salary
comparison like `"< R$ 2000 >"` would have had `" R$ 2000 "` silently
deleted before the prompt was ever built, exactly the kind of invisible
data loss this ADR exists to prevent. Fixed by requiring the same
"starts with a letter or `/`" condition the markup-detection regex already
used, and covered by a regression test (`test/scoring/domain/html-to-text.test.ts`)
that asserts the text survives intact, not merely that the flag is
correct.

## Consequences

- A pathological or adversarial posting description can no longer make a
  single Stage A call arbitrarily large, and the worst case (12,000 chars
  of normalized text, ~40 requirements of ≤500 chars each) is now
  measurable in the same way ADR-035's cost model measures attempt counts.
- Truncation is a recorded fact (`inputTruncated`) rather than a silent
  quality regression, at the cost of one more field threaded through
  `ScoreResult` that today has no reader beyond the type itself — accepted
  because the alternative (compute it but not expose it) reintroduces the
  same "silent" problem this ADR closes.
- The character-based budget is a proxy, not an exact token count — this
  project still has no tokenizer dependency, so a description dense in
  multi-token words could still exceed a "real" token budget the character
  ceiling does not directly track. The ceiling is deliberately generous
  precisely because it is a proxy, not a promise of exactness.
- `sanitizeLogLabel`'s 60-character cap means a very long requirement text
  is no longer fully visible in a correlation log line — acceptable, since
  a label's job (docs/08-observability.md) is eyeball correlation, not a
  transcript, and the full requirement is still recoverable from the
  extraction cache row by fingerprint.
- This closes AC-017 and PR-010 from the 2026-08-17 post-remediation audit.
  It does not address any of that audit's other open or partial findings
  (PR-001 through PR-009, PR-011 onward) — those remain tracked in the
  audit document and are out of scope for this change.
