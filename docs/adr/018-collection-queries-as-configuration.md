# ADR-018 — Ask the source a narrow question, and treat a cycle as one run

## Status

Accepted

## Date

2026-08-15

## Context

M10 closed with an honest gap: Stage A had real extractions for only 16
postings, so market intelligence and gap analysis were computing over a
sample too thin to say much. The obvious reading was that the pre-filter was
too aggressive — it discarded 95.8% of the corpus.

Measuring it said otherwise. Of 380 active postings, the pre-filter rejected
187 for not being internships at all, 123 on the title blocklist, and 52 on
location — and inspection showed the location rejections were **correct**:
São Paulo, Curitiba, Recife, Florianópolis. Only 7 of 81 internship-titled
postings were in Rio and 8 were remote. Loosening the filter would have spent
real API credit scoring internships in cities that cannot be accepted.

The cause was upstream. `SchedulerService` called:

```ts
await executeCollect(this.db, new GupyCollector(), {});
```

An **empty query**. `GupyCollector` has supported `jobName`, `city` and
`isRemoteWork` since M3; the cron simply never used them, so Gupy returned
whatever it liked — a nationwide, all-seniority slice — and the pipeline
downloaded it in full before throwing 95% away. ADR-011 had already predicted
exactly this: _"most of what the pre-filter cuts is geography, and geography
is cheaper to filter at the source than after downloading it."_

A hardcoded `{}` is also a straight violation of principle 3 (§7): search
strategy is a decision, and decisions belong in `config/criteria.yaml` where
`git log` explains them.

## Considered options

### Loosen the pre-filter (accept more cities, or drop the location rule)

Rejected. It treats the symptom and makes the product worse: the digest would
fill with postings that are geographically impossible, and every one of them
would cost a Stage A and Stage B call first. The 10-minute-triage goal
depends on the shortlist being _takeable_.

### Keep one empty query, raise `maxResults`

Rejected. Downloads more of the same nationwide slice. Cost scales linearly,
relevance does not.

### Configured, targeted queries (chosen)

`config/criteria.yaml` grows a `collection.queries` list — the questions the
cycle actually asks, currently the internship terms × (Rio de Janeiro |
remote). Both masculine and feminine forms are listed because Gupy matches
the query string literally: `estagiário` does not find "Pessoa Estagiária".

## Decision

**Collection queries are configuration**, in `config/criteria.yaml` under
`collection.queries`, defaulted to a single empty query so a criteria file
written before this section behaves exactly as it did.

**A collection cycle is one run, however many queries it issues.**
`executeCollect` takes a list and folds the results into a single `runs` row.
Recording one row per query was considered and rejected: two things already
count runs, and both would break. The digest's "collected since last
delivery" summary would still add up, but `evaluateCollectionHealth` alerts
on _consecutive empty collection runs_, and a legitimately empty query (no
remote `estagiária` postings today) would start tripping it on a healthy
cycle.

**Partial failure is degraded, not down.** Whatever succeeded is persisted,
the first error is reported on the outcome, and the run is marked `failed`
only when **every** query failed. One dead query out of six must not look
identical to a dead source (principle 1).

**Politeness spans queries.** The collector's ~1.5 s interval only spaces out
pages _within_ one query, so `executeCollect` sleeps `collection.queryIntervalMs`
between queries. Without it a six-query cycle would fire back-to-back requests
at five query boundaries — the exact behaviour CLAUDE.md §6 forbids.

## Consequences

**Measured on the real corpus, immediately after the change** — one real
`collect` + `dedup`, then `npm run measure:prefilter`:

|                            | before | after   |
| -------------------------- | ------ | ------- |
| active postings            | 380    | 491     |
| **passing the pre-filter** | **18** | **125** |
| pass rate                  | 4.7%   | 25.5%   |
| location rejections        | 62     | 64      |

The rejection counts barely moved while passes grew 7× — the new postings are
not squeezing past the filter, they are the kind of posting it was always
looking for. Of the 125, **77 are in Rio de Janeiro and 47 are remote**.

**The cost this creates, stated plainly:** 125 postings now reach Stage A
instead of 18, and Stage A is a paid model call per posting (ADR-012). The
nightly cycle got roughly seven times more expensive. That is the intended
trade — a 16-posting sample could not support M10's gap analysis — but it is
a real bill, and `SCORER_ADAPTER=stub` remains the way to exercise the
pipeline without it.

**What this does not fix:** 111 of the 125 classify as track `unknown`. They
are internships in the right place, but mostly not in the right field —
accounting, logistics, law. `trackAlignment` scores `unknown` at a deliberate
0.4 (ADR-011) so they will rank low rather than be discarded, but they are
still paid extractions. Narrowing `jobName` further (`estágio TI`,
`estágio desenvolvimento`) is the cheap next lever, and is a config edit under
this ADR rather than a new decision. Whether to gate on track in the
pre-filter is a genuinely different question — it would reverse ADR-011's
leniency rule — and is deliberately left open.

**Reversal cost:** low. Reverting to the old behaviour is deleting the
`collection` block from `criteria.yaml`; the schema default restores the
single empty query exactly.
