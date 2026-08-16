# ADR-025 — Cap the score of a posting that matches no configured track

## Status

Accepted

## Date

2026-08-16

## Context

The first real, non-trivial digest — 40 postings scored after ADR-022/#52/#53
made a real run affordable — surfaced a formula defect immediately, on a real
posting: **"Estagiário(a) de Benefícios" (an HR internship) scored 91,
`apply`, ahead of genuine dev postings at 63, `review`.**

Reconstructed from the actual cached matches: `mandatoryCoverage: 1.00`,
`desirableCoverage: 1.00`, `trackAlignment: 0.4` (unknown — the posting
classifies onto no configured track). `65×1.00 + 20×1.00 + 15×0.4 = 91`.

`docs/04-scoring-model.md` already documents the closest precedent to this —
the low-confidence rule, added when a _vague_ posting (zero mandatory
requirements) hit `mandatoryCoverage = 1` from the empty-category rule and
scored ≈85. This is the same failure shape wearing different clothes: an
**HR/sales/customer-service posting with a handful of easy, generic
requirements** ("boa comunicação", "disponibilidade", "ensino superior
cursando") saturates coverage near 1.0 not because it is a strong match, but
because it demands little of substance. `trackAlignment` is the term meant to
catch exactly this — "is this the _kind_ of job I am looking for?" — but at
15% of the formula, even its floor (`unknown: 0.4`) only costs 9 points
against a 100-point ceiling. Not enough to stop a generic posting from
outscoring a real one.

`trackWeights.unknown: 0.4`'s own stated reason (`docs/04`) is deliberate and
still correct on its own terms: "a posting the classifier cannot place is a
classifier gap, not a bad posting, and zeroing 15 points... would hide the
gap by pushing the posting out of the digest." That reasoning is about
**visibility**, not about **rank** — it argues an unknown-track posting
should not be discarded outright. It says nothing about whether it should be
allowed to outrank the postings the search actually exists to find.

## Considered options

### Reweight the formula (raise `trackAlignment`'s share)

Rejected. This is a global change to every posting's score, including
correctly-classified ones, to fix a problem that only manifests for `unknown`
postings. It would need recalibrating against the (already thin, 16/50) M7
labelled set to know what it actually does to `dev`/`security` scores, for a
fix that should only touch the `unknown` case.

### Zero out `trackWeights.unknown`

Rejected — narrowly better than the reweight but still capped by the same
15%-of-formula ceiling: even at `unknown: 0`, the Benefícios posting still
scores 65 + 20 = 85. The problem is not the _weight value_, it is that
`trackAlignment` structurally cannot dominate the other two terms enough to
matter here.

### A hard pre-filter exclusion for unknown-track postings

Rejected, and rejected for the reason `trackWeights.unknown` was made
non-zero in the first place: an unknown track is a **classifier gap**, and
`docs/02`'s pre-filter measurement discipline (`npm run measure:prefilter`)
depends on unknown-track postings staying visible in the corpus to notice
when the keyword table needs extending. Silently dropping them removes the
signal that would ever prompt fixing the classifier.

### A score cap when `tracks.length === 0` (chosen)

Same shape as the existing `blockingCapScore` precedent (docs/04: "the cap
only prevents a blocked posting from outranking a viable one"). Caps what an
unknown-track posting's coverage can buy it, without changing coverage math
for anything else and without hiding the posting.

## Decision

`ScoringConfig.unknownTrackCapScore` (required, no default — a criteria file
predating this should fail validation rather than silently keep producing
inflated scores). Set to **50** in `config/criteria.yaml`.

In `computeScore`: after the weighted `rawScore`, if `tracks.length === 0`,
`score = Math.min(score, config.unknownTrackCapScore)` — the same `Math.min`
shape `blockingCapScore` already uses, and the two **stack**: a blocked,
off-track posting is bound by whichever cap is lower, since they answer
different questions (a specific requirement failing vs. the posting not
being the kind of role searched for at all).

**50, not lower.** It sits inside the `review` band (45–69), not below it:
still visible, per `trackWeights.unknown`'s own original reasoning — an
unknown track is a classifier gap worth seeing, not a posting worth hiding —
but never again capable of reaching `apply` (≥70) on coverage alone.
Requested directly: postings reaching `apply` are meant to be a real signal,
and a generic off-track posting outranking genuine dev/security matches
undermines exactly that.

## Consequences

**Easy:** the concrete incident is fixed — recomputed, the Benefícios
posting drops from 91/`apply` to 50/`review`. Reversible in the cheap sense
(delete the `Math.min` line and the config field) since nothing about cached
matches or extractions depends on it — this is Stage C only, so a change
here does not touch the Stage A/B cache at all (unlike a prompt version
bump), and re-scoring an already-cached posting is free.

**A real question this does not answer**: the _reason_ coverage saturates
for these postings — soft/generic requirements read as trivially satisfiable
against almost any profile evidence — is untouched. This caps the symptom's
ceiling; it does not make Stage B any more discriminating about a vague
requirement. Worth watching whether 50 is the right number once more
labelled data exists — it is provisional, like every other weight on this
page, not a calibrated value.

**Explicitly out of scope, raised in the same conversation and declined**: a
company-reputation signal (a specific request to penalize named companies
with poor public ratings). Investigated and not built — Glassdoor's review
content sits behind login, which this project's own LinkedIn rule
(CLAUDE.md §3: never authenticate a collector with a personal session) would
extend to forbid on the same grounds. Reclame Aqui's public reputation index
is structurally fetchable (`robots.txt` allows company pages), but matching
a posting's stated company name to the right Reclame Aqui profile has no
stable shared identifier — a real accuracy risk none of this project's
existing sources carry, since Gupy/CIEE are both structured APIs, not
name-matched lookups. Declined for now rather than built; company reputation
carries no weight in scoring.
