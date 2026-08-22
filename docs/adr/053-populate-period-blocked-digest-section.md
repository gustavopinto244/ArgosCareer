# ADR-053 — Populate the period-blocked digest section

## Status

Accepted

## Date

2026-08-19

## Context

`digest.ts`'s `PeriodBlockedEntry` type and `render-digest.ts`'s "Abrem para
você em breve" section have existed since M7 (docs/audit AC-026) but were
never populated — `executeDeliver` always passed `periodBlocked: []`. A
period requirement the candidate does not yet meet ("cursando a partir do
4º período") was scored like any other unmet `blocking` requirement:
`findBlockingFailure` caught it, `computeScore` capped the score at
`blockingCapScore` (35), and the posting landed in `discard` looking exactly
like a real rejection. CLAUDE.md §9 already states the intended behavior:
"The digest must therefore put period-blocked postings in their own
section... That is planning information, not a rejection" — the gap was
that nothing ever computed it.

This stopped being a documentation gap and became a measured cost during the
first real M7 calibration run (`docs/11-known-issues.md`, expanding the
20-posting labelled worksheet toward 50). Real production examples,
capped to 35 purely by a period gate:

| Posting                                  | Hand score | Computed (before) | Blocking requirement                                      |
| ---------------------------------------- | ---------- | ----------------- | --------------------------------------------------------- |
| Flamengo — Análise de Dados              | 70         | 35 (`discard`)    | "Cursando a partir do 4º período de Educação Física, ..." |
| MIDI Participações — Estágio Informática | 65         | 35 (`discard`)    | "Semestre exigido: 4 a 9"                                 |

Both are exactly the case CLAUDE.md §9 describes: a good match the
candidate cannot take yet, not a bad match. Two of six "good posting scored
too low" cases in that calibration run had this single cause.

Nothing structural changed about _how_ the requirement is extracted —
Stage A already produces it as a normal `blocking` requirement, and Stage B
already matches it `not_met` like any other. What was missing is purely
Stage C: turning that specific requirement's _text_ into a structured
minimum period comparable against `computeAcademicPeriod`.

## Considered options

### Add a structured period field to `Posting`, sourced from CIEE's `semestreInicio`/`semestreFinal`

CIEE's raw schema (`ciee-schema.ts`) already carries this as structured
data, currently flattened into free-text `description` and lost
(`docs/11-known-issues.md`). Rejected as the primary mechanism: every real
example found so far is a Gupy posting, where the period gate exists only
as requirement _text_, never a structured field — a CIEE-only fix would
miss every case actually observed. Worth doing later as a second, more
reliable source for the one collector that has it; not a substitute for
reading the extracted requirement text.

### Parse the requirement text Stage A already extracts

Chosen. Works across every source, since it operates on `Requirement.text`
— already-normalized output Stage A produces regardless of which collector
found the posting — not on a source-specific raw field. Heuristic (a
regex over natural-language Portuguese), not authoritative, and documented
as such in `period-gate.ts`: a phrasing the patterns do not recognize is a
missed case (identical to today's behavior, not a regression), never a
false positive strong enough to matter, because every pattern requires an
explicit trigger phrase next to the number.

## Decision

`src/scoring/domain/period-gate.ts` adds `extractMinimumPeriod` (a
small, conservative set of regexes over the requirement text) and
`detectPeriodGate`, which fires only when a not-yet-reached period is the
**entire** reason the posting is blocked — exactly one unmet `blocking`
requirement, and it parses as a period gate. Any other unmet blocking
requirement alongside it means a real rejection independent of timing, and
`detectPeriodGate` returns `null`.

`computeScore` gains an optional fourth parameter, `academicContext:
{ courseStart, today }`. Optional so the 35+ existing call sites (tests,
`StubScorer`, `market-repository.ts`'s historical re-scoring) are
unaffected — only `ApiScorer.score`, which has a real profile and a real
clock, supplies it. `ScoreOutcome` gains two fields: `blockingFailures`
(every unmet blocking requirement, not just the first — `detectPeriodGate`
needs the full set to tell "period gate alone" from "period gate plus
something else") and `periodGate` (non-null only when the gate fires).

A gate is only surfaced when the posting is otherwise worth mentioning:
`periodGate` stays `null` unless the **uncapped** `rawScore` would already
clear the `review` threshold. A posting that would not clear review even
ignoring the period gate is a weak match that also has a period gate, not
"a good fit you're not eligible for yet" — it stays an ordinary `discard`.

`executeDeliver` (`src/cli/main.ts`) routes a `periodGate` result into a
`PeriodBlockedEntry` (`{ posting, opensAtLabel }`) instead of the normal
`scoredEntries` bucket. `opensAtLabel` comes from
`periodCalendarLabel` (`academic-period.ts`), the exact inverse of
`computeAcademicPeriod` — same semester-boundary arithmetic, solved for the
calendar term instead of the period number.

A period-blocked posting is **not** marked `notifiedAt` — `sent` in
`executeDeliver` is still exactly `[...digest.recommended,
...digest.review]`, unchanged. It surfaces in the digest's period-blocked
section every run until the gate actually clears, at which point normal
scoring picks it up and it is notified for real. Its Stage A/B claim is
still released via the existing unconditional `releaseUnresolvedClaims`
call, so it is re-evaluated (cheaply — cache hit, no new model call) rather
than left claimed.

## Consequences

**Easy:** additive on every axis — new optional parameter, new optional
return fields, a new pure module, no cache invalidation (Stage A/B outputs
are unchanged; only Stage C's interpretation of an existing `blockingFailure`
changes). The renderer (`render-digest.ts`) and the type
(`PeriodBlockedEntry`) already existed and needed no changes at all.

**The real cost, stated plainly:** the parser is a natural-language
heuristic over Portuguese job-posting text, not a guarantee. A phrasing
outside its four patterns is a silent miss — the posting stays capped at 35
exactly as before this ADR, which is a safe failure mode (status quo, not a
regression) but means the section's completeness depends on Stage A's
extracted wording matching one of the recognized shapes. Widening the
pattern set is safe to do incrementally as new real phrasings are observed;
guessing more patterns without a real example to test against would violate
CLAUDE.md §15.

**Does not touch the four calibration cases this ADR did not cause:**
of the six "good posting scored too low" cases the same calibration run
found, four (Bemobi Wave, ELDORADO, Anbima DevOps, Smarthis) are low
`mandatoryCoverage` from Stage B matching, not a period gate. Those are a
separate, harder question — model/prompt/evidence-matching quality — and
fixing them by guessing would violate the M7 protocol's "change one
variable at a time" discipline. They stay open, tracked as their own
finding pending a larger labelled set.

**Reversible:** deleting `period-gate.ts` and its two call sites in
`score.ts`/`main.ts` returns every posting to exactly its pre-ADR-053
behavior — no migration, no cache to invalidate, no persisted state this
ADR introduces beyond the digest content itself.
