# ADR-026 — Recalibrate the score weights toward track fit

## Status

Accepted. Amends [ADR-005](005-llm-does-not-produce-the-score.md) (Amendment 1)
— the illustrative formula in its Decision section named specific numbers
that are now stale; the architectural decision it records (compute the score
in code, three stages, evidence-quote requirement) is untouched.

## Date

2026-08-16

## Context

The same first real digest that surfaced ADR-025's bug surfaced a second,
independent one, on the two genuinely on-track postings in it:

| Posting                         | Track       | mandatoryCoverage | desirableCoverage | Score |
| ------------------------------- | ----------- | ----------------- | ----------------- | ----- |
| ELDORADO, "Desenvolvimento Web" | `dev` (1.0) | 0.58              | 0.50              | 63    |
| Korp ERP, "C# ou Go + Angular"  | `dev` (1.0) | 0.50              | 0.75              | 63    |

Both `review`, neither `apply`. Traced requirement-by-requirement: both gaps
are real — ELDORADO's posting asks for Angular and Java/Spring Boot, neither
evidenced in the profile; Korp's asks for Angular and C#/Go, same story. Not
a bug: ADR-015's unverifiable-trait exclusion was independently confirmed
still working correctly on the same data (the "boa comunicação"-style items
in ELDORADO's posting are excluded from coverage, not counted as failures —
recomputing by hand without them reproduces the reported 0.58 exactly).

Requested directly: these are the right _kind_ of role — `trackAlignment`
already says so, at 1.0 — and a posting matching every stated requirement
except one or two specific named technologies should not sit at the same
altitude as a posting that is not a development role at all. **65% of the
formula riding on literal requirement-text coverage leaves `trackAlignment`'s
15% unable to say "this is the job you're looking for" loudly enough to
matter.**

## Considered options

### Add a floor score for on-track postings above some coverage threshold

Structurally similar to ADR-025's cap, mirrored as a floor. Considered, not
what was asked: the user specifically requested a weight recalibration —
apply universally, not a special-cased floor bolted onto the formula for one
scenario. A floor is also harder to reason about in combination with the
existing caps (does a floor apply before or after `blockingCapScore`? What
happens to a floored posting that also matches no track?) — a reweight has
no such ordering question, since it changes `rawScore` itself, upstream of
every cap.

### A smaller reweight (e.g. 45/20/35) that moves in the same direction without guaranteeing 75

Computed and shown to the user before deciding: 71.1 / 72.5 for the two
examples — directionally right, does not deliver what was asked. Declined in
favor of the weights that actually clear 75 for both, chosen deliberately
over reverse-engineering to hit two numbers exactly (see Decision).

## Decision

`scoring.weights` in `config/criteria.yaml` moves from `65 / 20 / 15` to
**`35 / 20 / 45`** (mandatory / desirable / trackAlignment).

Not solved backward from "what exact numbers make these two postings hit
75.0" — that would be fitting a formula to two data points, the same
overfitting `docs/04`'s calibration protocol exists to prevent. `desirable`
is left untouched at 20; the swap moves 30 points from `mandatoryCoverage`
directly to `trackAlignment`, the most direct expression of "track fit
should matter nearly as much as literal requirement coverage" — the request
as stated. It happens to clear both examples (75.3 and 77.5) as a
consequence of that principle, not as the goal being solved for.

The trade-off was computed and shown before this was confirmed, not
discovered after: an on-track posting meeting **none** of its requirements
now scores `45×1.0 = 45` on track alone — up from `15×1.0 = 15` — landing at
the `review` threshold instead of clearly in `discard` territory. Accepted
knowingly.

`unknownTrackCapScore` (ADR-025, still 50) is unaffected — it is a `Math.min`
applied to the final score regardless of how the weighted terms produced it,
so it continues capping an unknown-track posting exactly as before even
though `trackAlignment`'s weight changed. Verified: the worst case for an
unknown track (`mandatoryCoverage = desirableCoverage = 1.0`) now computes a
raw score of 73 (up from 91 under the old weights, since `mandatory`'s share
shrank) — still well above the 50 cap, so the cap still binds.

## Consequences

**Easy:** the concrete request is met — both postings clear 75 under the new
weights, and the change is one config edit, no code touched, no Stage A/B
cache invalidated (Stage C has no cache; recomputing an already-matched
posting under new weights is free on the next run).

**The real cost, stated plainly:** `mandatoryCoverage` — literally "does the
candidate meet what the posting asks for" — now matters _less_ than track
classification for ranking. A posting that is the right kind of role but a
weak match on paper now outranks postings that were previously scored on
their merits more heavily. This is the explicit, accepted trade of this
ADR, not a side effect discovered later.

**Provisional, not calibrated.** `35/20/45` is reverse-engineered from two
examples' _shape_ (right track, real but partial gaps), not validated
against the M7 labelled set (16/50, already thin before this). It should be
revisited once real calibration data exists to say whether this over- or
under-corrects — `docs/04`'s own discipline: every weight on that page is a
hypothesis, this one included.

**Interacts with ADR-025's cap, not the reweight's fault**: the same
reweighting that helps an on-track, partially-matched posting also lets a
near-zero-coverage on-track posting climb closer to `review`. This ADR does
not add a new floor to prevent that — it is an accepted consequence of
raising `trackAlignment`'s share, and future calibration data is what would
tell whether it needs its own bound.
