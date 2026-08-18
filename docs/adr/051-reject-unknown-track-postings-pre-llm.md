# ADR-051 — Reject unknown-track postings before the LLM, behind a flag

## Status

Accepted

## Date

2026-08-17

## Context

A calibration run (`argos deliver`, run `01M09542FFR83M5V8HPSAQ68F3`)
collected 4,219 raw items, 2,126 new after dedup, and the pre-filter cut that
to 28 candidates — the deterministic gate itself worked exactly as designed,
nowhere near "hundreds of postings" reaching the LLM.

But every one of those 28 classified `tracks: []` (`classifyTrack` matched
none of `dev`/`security`/`automation`) — confirmed against
`posting_events.metadata.tracks` for the run. The delivered digest was
Segurança do Trabalho, Jurídico, RH, Marketing, Contabilidade, Design,
Fisioterapia, Educação Física, Logística, Suporte Acadêmico, Social Media and
Real Estate/Compliance internships. Not one genuine backend/security/infra
posting. "Recomendadas" (score ≥70) was empty.

`unknownTrackCapScore` (ADR-025) did its job — it kept every one of these off
`apply` — but it does not stop them from being scored at all: 25 of the 28
still reached Stage A/B, spending real LLM budget ($0.034, 125 attempts) and,
because 57/125 attempts also failed with `invalidOutput` this run, ending up
in the "Vale avaliar" section as `⚠ Não foi possível pontuar automaticamente`
rather than being excluded. The net result was a digest dominated by postings
that are not merely low-scoring, they are outside the search profile
(CLAUDE.md §1: back-end dev, information security, infrastructure/automation
— nothing else) entirely.

ADR-025 already considered and rejected "a hard pre-filter exclusion for
unknown-track postings," on the grounds that an unknown track is a
**classifier gap**, and `measure:prefilter`'s discipline depends on
unknown-track postings staying visible in the corpus to notice when the
keyword table needs extending. That reasoning does not actually require the
posting to reach the LLM, though — `applyPreFilter` already records `tracks`
on every posting **regardless of pass/fail** (the field's own doc comment:
"populated, pass or fail... useful for M10's market analysis, which reads
the whole corpus, not the shortlist"). Rejecting at the pre-filter still
leaves the classifier-gap signal fully queryable via `posting_events`; it
only stops the signal from costing LLM budget and cluttering the digest.

## Considered options

### Do nothing — rely on `unknownTrackCapScore` alone

Rejected. It bounds _rank_, not _whether the LLM runs at all_ or _whether the
posting appears in the digest_. Measured this run: it did not stop an
HR/Jurídico/Marketing-dominated digest from being the entire delivered
output.

### Widen `tracks`/`trackExclusions` keyword lists instead

Deferred, not rejected outright. Some of the 28 (e.g. "Estagiário (TI) —
Suporte a Sistemas") are IT-adjacent without being backend/security/infra
specifically — closer to general IT support, which CLAUDE.md's search
profile does not name as a target track either. Widening keyword lists is
the right tool for _false negatives on genuinely in-scope titles_ (ADR-011's
`probe:terms` measurement discipline), not for excluding out-of-profile
domains like HR or Marketing that no plausible keyword addition would ever
touch. Left as a separate, measured effort if a real dev/security posting is
later found misclassified as unknown.

### Reject unknown-track postings in the pre-filter, opt-in via a flag (chosen)

Reuses `classifyTrack`'s existing output — no new classification logic,
purely a new gate on a value the pre-filter already computes for every
posting. Configurable (`rejectUnknownTrack`, default `false`) rather than
unconditional, so a criteria file predating this keeps behaving as it did,
and the flag can be turned off if the keyword lists ever need visibility
into what they are missing without going back to code — same posture as
`minKeywordAdherence` being set to `0` after it once rejected real postings.

## Decision

`Criteria.rejectUnknownTrack: boolean`, default `false`. When `true`,
`applyPreFilter` rejects a posting with `tracks.length === 0` as
`"track_unknown"`, checked right after the title-required rule — both are
cheap, title-only string checks, so grouping them costs nothing extra and
keeps the "cheapest and most decisive first" rule ordering intact.

Set `true` in `config/criteria.yaml`, with the calibration-run numbers
recorded in the config comment.

`unknownTrackCapScore` (ADR-025) is unchanged and still applies — it is what
protects `apply` if this flag is ever turned back off, and it is not
made redundant by this change, only currently unreachable while the flag is
on.

## Consequences

**Measured effect** (`npm run measure:prefilter` against the real corpus,
before/after): 28 → 3 postings pass. Manually checked the 3: "Estágio em
Desenvolvimento Backend," "Estágio em desenvolvimento Web," "Estágio de
Desenvolvimento | C# ou Go (Golang) + Angular" — all genuinely `dev`. No
on-track posting was observed to be lost by this change on the current
corpus; the 25 rejected were the HR/Jurídico/Marketing/Design/etc. postings
enumerated in Context.

**LLM budget**: same effect as a smaller candidate set, no code change to
Stage A/B — fewer postings reach `applyPreFilter`'s passing branch, so fewer
`scoreAndDeliver` calls per night.

**Visibility is retained, not lost**: `tracks` is still computed and
recorded in `posting_events` for a `track_unknown` rejection, same as any
other rejection reason — M10's market analysis and a future
`measure:prefilter`-style script can still see how large the unknown-track
population is and what its titles look like, without those postings ever
reaching the LLM or the digest.

**Real, accepted risk**: title-only, keyword-based classification
(`classify-track.ts`) has false negatives by construction — a genuinely
in-scope posting with an unusually generic title would now be silently
excluded rather than merely capped. Mitigated by the same discipline ADR-011
established for `tracks`/`trackExclusions`: revisit with `probe:terms`-style
measurement if a real dev/security posting is ever found misclassified as
unknown, rather than guessing at keyword additions now.

## Amendment 1 — 2026-08-17: two audits, then five IT-support keywords added to `automation`

Two follow-up checks were run before touching the keyword lists, both
against the real corpus with `rejectUnknownTrack` applied.

**Audit A — anything genuinely on-track being lost to a _different_ rule?**
Computed `classifyTrack` independently of `applyPreFilter`'s pass/fail, then
looked for postings where `tracks` is non-empty (`dev`/`security`/
`automation`) but the posting was still rejected — by any reason, not just
`track_unknown`. 274 such postings exist in the active corpus. All 274
checked by category:

- `title_blocked` (75) and `title_missing_required_term` (117): senior/pleno/
  especialista full-time roles ("Desenvolvedor Backend Sênior", "DevOps
  Engineer", "Analista de Infraestrutura Sênior") — not internships, and
  CLAUDE.md §2 already excludes junior/entry-level, let alone senior. Working
  as designed.
- `too_old` (79): genuinely internship-titled ("Estágio em Informática",
  "Estágio em Desenvolvimento Backend", "Estágio em Segurança da
  Informação") but stale — mostly CIEE's bulk-imported backlog, caught by
  `undatedBacklogCutoverAt`/`maxAgeDays` (ADR-011 Amendments 4-5), unrelated
  to this ADR's flag.
- `location_not_allowed` (2), `expired` (1): outside the Rio metro/remote
  search profile, or past deadline.

No posting in this set was lost to a bug interacting with
`rejectUnknownTrack` — every rejection traces to a separate, already-reasoned
rule doing its job. The pre-filter's recall for genuinely in-scope,
current, in-region internships is intact.

**Audit B — precision-checking candidate keywords before adding them.**
Requested directly, after Context's five borderline titles (Service Desk,
"Suporte a Sistemas", bare "TI", "Suporte e Operações", "Estagiário de
Projetos"): measured `keywordMatchesText` (the same whole-word matcher
`classifyTrack` already uses) against the full active corpus for each
candidate term before adding any of them, per ADR-011's own discipline.
"TI" alone: 61 matches, manually read in full — every one is genuinely
IT-department work (infra, sysadmin, suporte, service desk), zero false
positives like the "soc"/"api" collisions ADR-011 Amendment 2 found. "help
desk" and "helpdesk": zero matches on the current corpus, so not added —
nothing to justify them yet.

Added to `tracks.automation` (not `security`): `ti`, `tecnologia da
informação`, `suporte a sistemas`, `service desk`, `suporte técnico`.
`automation` (weight 0.7), not `security` (1.0), because this vocabulary is
IT-operations-flavored, not information-security work — matching
CLAUDE.md §1's own priority split (dev and security equal at priority 1,
infrastructure/automation at priority 2). Note in passing, not acted on
here: `security`'s existing keyword list already carries `infraestrutura`/
`infrastructure` at the full 1.0 weight, which sits at some tension with
that same priority split — pre-existing, not introduced by this change, and
left alone rather than folded into an unrelated ADR.

"Estagiário de Projetos" (Code n' App) stays unclassified — no keyword in
its title says anything about software, and inventing one from the company
name alone is exactly the unmeasured guess ADR-011 exists to avoid.
