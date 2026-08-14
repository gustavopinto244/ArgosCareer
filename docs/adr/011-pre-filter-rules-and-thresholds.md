# ADR-011 — Pre-filter rules, ordering, and the unknown-axis leniency rule

## Status

Accepted

## Date

2026-08-14

## Context

`docs/02-architecture.md` names six pre-filter rules and defers their exact
behavior and ordering to M5: "Rules and thresholds get an ADR in M5." Three
questions had no answer anywhere before this milestone:

1. What happens when `location` or `workMode` is `unknown` — a real
   possibility now that both are separate axes (`05-domain-model.md`) and
   Gupy does not always state a work mode?
2. In what order do six rules run, given each rejection records exactly one
   reason (`05-domain-model.md`, "rejection is always recorded with a
   reason")?
3. What does "minimum keyword adherence" check against, given `Posting` has
   no full description field?

## Decision

### The six rules, in this order

| #   | Rule                      | Rejects when                                                            |
| --- | ------------------------- | ----------------------------------------------------------------------- |
| 1   | Title blocklist           | Title contains a blocked term (`sênior`, `pleno`, …)                    |
| 2   | Title required            | Title contains **none** of the required terms (`estágio`, `intern`, …)  |
| 3   | Blocked companies         | Company matches a configured blocklist entry                            |
| 4   | Expired                   | `applicationDeadline` is set and in the past                            |
| 5   | Location                  | See below                                                               |
| 6   | Minimum keyword adherence | Fewer than the configured floor of profile keywords appear in the title |

**Order is cheapest and most decisive first.** Rules 1–2 are single-field
string checks; 3–4 are single-field checks against configuration; 5 reads two
fields and has real branching logic; 6 scans the entire profile keyword list
against the title and is the only rule whose cost scales with an external
input's size. Putting it last means a posting that would fail on title alone
never pays for a keyword scan.

**Short-circuit at the first failure.** Every rejection records exactly one
reason — accumulating every failing rule was considered and rejected, since
pre-filter is a pass/fail gate, not a scoring formula where multiple partial
failures compound meaningfully (unlike stage C's coverage terms). A posting
failing both the title blocklist and the location rule reports
`title_blocked`; fixing the title would surface the location problem on the
next run, which is an acceptable cost for a simpler, faster, and more
predictable function.

### Location and `workMode`: reject only when both axes are known-bad

The rule is "Rio de Janeiro metro, or remote." With `location` and `workMode`
as independent axes (`05-domain-model.md`), a posting can be `unknown` on
either without being unknown on both.

**Rejected only when `workMode` is known and not remote, _and_ `location` is
known and not in the configured cities.** Either axis being `unknown` passes:

- `workMode: "unknown"` — the posting cannot be ruled out as remote, so it is
  not rejected on location grounds regardless of what the location field says.
- `location: { kind: "unknown" }` — the posting cannot be ruled out as being
  in the target region, so a known non-remote `workMode` alone does not reject
  it either.

This is the M5 requirement stated directly: `unknown` must not be silently
discarded (that would punish a data gap as if it were evidence of a bad fit,
the same reasoning `trackAlignment`'s non-zero `unknown` weight already
applies) or silently accepted (that would defeat the rule's purpose whenever
data is missing, which for `workMode` on Gupy is not rare).

### Minimum keyword adherence checks the title only

Considered checking a full description too. Rejected for this milestone:
`Posting` does not retain one (`05-domain-model.md` scopes it out), and
adding it would mean another domain and schema change beyond what this
milestone's own scope decisions already required (`applicationDeadline`, added
this same milestone once the expiry rule needed it). Title-only keeps the
rule's cost bounded and its behavior easy to reason about; revisit if
`insufficient_keyword_adherence` and `unknown` track classification turn out
to be common once there is real run data to measure against, the same
condition `classify-track.ts` names for its own title-only scope.

### Track classification is always computed, pass or fail

`PreFilterOutcome.tracks` is populated on a rejected posting, not only a
passing one. Classification is cheap and the result is useful independent of
the filter's verdict — M10's market analysis reads the whole corpus, not the
shortlist (`05-domain-model.md`).

## Consequences

- The unknown-axis leniency rule means a posting with no stated `workMode`
  from a city outside the target list still passes. This is deliberate — see
  the reasoning above — but it does mean the pre-filter's cut is smaller
  against a source that under-reports `workMode` than it would be against one
  that always states it. Worth watching if Gupy's `workMode` completeness
  changes.
- **The ~70% cut estimate is replaced with two measured numbers, not one** —
  97.1% against a nationwide collection, 84.2% against one narrowed to Rio de
  Janeiro server-side (`docs/02-architecture.md`, `scripts/measure-prefilter-cut.ts`).
  The gap between them is the actual finding: most of what the pre-filter cuts
  is geography, and geography is cheaper to filter at the source than after
  downloading it. Unlike the estimate it replaces, both numbers are
  reproducible on demand — re-run `npm run measure:prefilter` over the corpus
  any time and compare.
- `minKeywordAdherence` checking title-only rather than title+description is
  the shallowest of the six rules. If it proves too shallow to matter (every
  posting either has 0 or hits any nonzero floor trivially), that is itself a
  finding worth recording rather than silently leaving the floor at a
  value that never actually filters anything.
- Reversing the rule order is cheap — `applyPreFilter` is a straight-line
  function with no shared state between rules — but reversing the
  unknown-axis leniency decision is not: it would need re-evaluating every
  posting already in the corpus that passed because of it, not just a config
  change.
