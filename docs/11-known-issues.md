# 11 — Known issues

## What this page is for

`docs/10-milestones.md` records what each milestone deferred, organised by
milestone. That is the wrong shape for a problem found in production, which
belongs to no milestone and is discovered in the order incidents happen rather
than the order work was planned.

This page is the register for those. One entry per problem, each with what it
actually is, how it was observed, and what resolving it would take. An entry
leaves this page when it is fixed — in the same pull request that fixes it —
or when it is deliberately accepted, in which case it moves to an ADR that
says so.

**Nothing here is a nice-to-have.** Ideas and improvements belong in
`docs/10`. This page is for things that are wrong.

Opened 2026-08-16, after the incident recorded in
[PR #49](https://github.com/gustavopinto244/ArgosCareer/pull/49).

---

## Severity

|       | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| **A** | Breaks a promise the system makes. Fix before it happens again.             |
| **B** | Real defect with a bounded blast radius, or a latent one not yet triggered. |
| **C** | Correct as built, but the behaviour is misleading or undocumented.          |

---

## A1 — Scoring the backlog takes ~18 hours

**Status:** fixed by ADR-022, pending measurement on a real run ·
**Found:** 2026-08-16, measuring the fix for #49

> **Resolution.** Stage B now issues its requirement calls concurrently,
> bounded by `scoring.stageBConcurrency` (default 8), with the first call of
> each posting issued alone to warm ADR-013's cached prefix.
>
> Measured on the same posting, same 25 requirements, cache-busted so both
> arms really call the model: **146.9 s → 10.2 s, a 14.4× speedup**, and cost
> fell rather than rose. Full reasoning, the measurement's caveats, and why
> batching was rejected for now, in
> [ADR-022](adr/022-bounded-concurrency-in-stage-b.md).
>
> **The backlog is now ~4–6 h, not ~18 h — but not the 2–3 h first guessed,
> because the bottleneck moved rather than disappeared.** See A3. This entry
> stays open until a real run replaces the extrapolation with a number.
>
> One correction to what this entry originally said: it claimed bounded
> concurrency "changes scoring behaviour". It does not. Same prompt per
> requirement, same isolation, same cache keys, same answers — only the
> waiting overlaps. Batching is the option that changes behaviour.

Stage B issues one sequential model call **per requirement**. One real posting
measured end to end against `deepseek/deepseek-v4-flash-0731`:

|              |                                  |
| ------------ | -------------------------------- |
| Calls        | 26 (1 stage A + 25 stage B)      |
| Duration     | **213.8 s**                      |
| Cost         | $0.0026                          |
| Prompt cache | 25 088 / 35 421 tokens hit (71%) |

310 postings currently pass the pre-filter. Extrapolated: **≈ 18.4 hours** and
~$0.80 for one pass. The cost is irrelevant; the wall-clock is not. A nightly
cycle starting at 03:00 finishes in the evening, and ADR-009's "the only
window the model runs in" stops being true.

The 71% cache hit rate says ADR-013's static-prefix design is working, so the
remaining time is latency × 26 round trips, not prompt size.

**Related:** A2 — an 18-hour run and a scheduler with no overlap guard are
only compatible by luck. Concurrency shortens the run; it does not add the
guard, and A2 stays open.

**Also related:** concurrency makes HTTP 429 reachable where sequential calls
never approached a rate limit, and `OpenRouterClient` folds a non-2xx into the
retry budget instead of backing off. Same shape as B3. Not triggered yet;
noted so it is not a surprise if it is.

---

## A3 — Stage A is now the pipeline's bottleneck

**Status:** open · **Found:** 2026-08-16, measuring ADR-022

With Stage B down to ~10 s per posting, the dominant cost is Stage A: one call
per posting, emitting the entire requirement list as JSON, which is the
largest completion the pipeline produces. Back-solved from the ADR-022
measurements it sits around **40–67 s per posting**, against ~10 s for all 25
Stage B calls combined.

Stage A cannot be split the way Stage B was — it is a single call, not a fan
out. The levers are different ones:

- **Concurrency across postings.** ADR-022 rejected this for Stage B (option
  D) because Stage B already had a better axis. Stage A does not, so the
  reasoning that rejected it does not carry over and it should be
  re-evaluated on its own terms.
- **A smaller completion.** Much of Stage A's output is requirement text
  copied near-verbatim from the posting. Whether it needs to be is a prompt
  question, and a prompt change means a new version and recalibration.

Both are scoring-adjacent enough to want an ADR, and neither should be
attempted while the numbers are extrapolations from a handful of postings.
**Measure the first real backlog run first.**

---

## A2 — The scheduler has no overlap guard

**Status:** fixed by ADR-024 · **Found:** 2026-08-16, sweeping after #49

`SchedulerService` registered both cron jobs with
`onTick: () => void this.run…Cycle()` and nothing tracked whether the
previous tick was still running. This stopped being theoretical the same
day: `POST /runs/deliver` was called manually to test a build while the
scheduled cycle's own multi-hour run (ADR-022) was in flight, and only a
direct database check established the two had not actually collided.

> **Resolution.** `RunLock` (`scheduling/domain/run-lock.ts`), one
> in-memory, per-kind lock shared by `SchedulerService` and `RunsService`
> via the same DI token — sufficient because both live in one process
> (`app.module.ts`). A locked-out REST/MCP call gets 409; a locked-out cron
> tick logs and skips, no alert (an expected outcome, not a failure).
> Mutation-checked at both layers — the core `tryAcquire` guard, disabled,
> fails 6 tests including two real concurrent-HTTP-request integration
> tests, not just the pure unit tests. Full reasoning in
> [ADR-024](adr/024-scheduler-overlap-guard.md).
>
> **Explicitly not covered:** a separate process (e.g. the CLI invoked by
> hand via `docker exec`) racing the running server. An in-memory lock
> cannot see across process boundaries; ADR-024 states this as a deliberate
> limitation, not solved speculatively for a risk that has not been
> observed.

---

## B1 — CIEE is exempt from the recency window

**Status:** open, LLM cost mitigated · **Found:** 2026-08-16, explaining a
`normalized: 0` run

ADR-019 filters **collected** postings by publication date, with
`recencyDays: 1`, and deliberately lets a posting with no date through:
absence of a date is not evidence of an old posting.

In production, **every** CIEE posting has no date, and the Gupy figure has
gotten worse since this entry was first written:

```
source  count  published_at IS NULL
ciee     2079  2079   (100%)
gupy      558   436   (78%, was 44% on 2026-08-15)
```

CIEE supplies 89% of the corpus, so for the dominant source the window is not
lenient — it is inert. This is why 2092 postings entered in a single cycle on
2026-08-16 and why scheduled runs alternate between `normalized: 0` (Gupy
only, all older than a day) and thousands.

Not a bug in the sense that the code does what ADR-019 says. The problem is
that ADR-019's reasoning assumed the undated posting was the exception.

> **Mitigated at the pre-filter, 2026-08-16.** `criteria.maxAgeDays`
> (ADR-011 Amendment 4) stops an old posting from reaching the LLM, with the
> same `firstSeenAt` fallback this entry proposed, and
> `criteria.undatedBacklogCutoverAt` (Amendment 5) turns that into an
> immediate business rule rather than a week-long wait: every undated
> posting collected up to 2026-08-16T12:15:00Z — the entire pre-existing
> CIEE backlog — is presumed already past `maxAgeDays` outright, once this
> code is deployed. **This is still a pre-filter rule, not a collection
> rule — a different stage from the one this entry is actually about.** It
> bounds what gets scored, which is the concrete cost this project pays
> (Stage A/B calls). It does nothing about what ADR-019 governs: the corpus
> itself still grows without limit, every CIEE posting is still collected
> and stored regardless of age, and `recencyDays: 1` is still inert for
> 100% of CIEE. Left open for that reason.
>
> **Deployment note:** this needs a container restart to take effect, and a
> restart mid-run kills whatever `scoreAndDeliver` cycle is in flight — no
> graceful drain exists, so the run's row orphans (C1) and that night's
> digest does not go out. Deploy only between cycles, never during one.

**Resolving the rest** means deciding what "recent" means for a source that
never publishes dates, at the **collection** stage — not re-admitting the
whole corpus on the first run that adopts it. Amends ADR-019.

---

## B2 — The `runs` table records no failure reason

**Status:** open · **Found:** 2026-08-16, trying to explain a collect run

`executeCollect` computes `tooOld`, `unnormalizable` and a first `error`
string, and returns all three on its outcome. None is persisted: the `runs`
table has counters and an `outcome` enum, and nothing else.

So a row reading `collectedCount: 313, normalizedCount: 0` cannot be explained
after the fact — recency window, missing normalizer, and a source that
returned nothing are indistinguishable. Worse, a single source failing among
several still records `success`, by design (principle 1, partial failure is
degraded not down), with nothing in the row naming which one failed.

`docs/08` already identifies silent degradation as the failure mode this
project most needs to catch. This is a hole in exactly that.

**Resolving it** means columns for the drop reasons and the first error, plus
a per-source breakdown — the `failedSources` list in `executeDeliver` is
currently hardcoded to `["gupy"]` with a comment admitting it, which is a
second symptom of the same gap.

---

## B3 — Telegram delivery has no pacing and no 429 handling

**Status:** open · **Found:** 2026-08-16, sizing the digest A1 will produce

`TelegramNotifier` splits a digest into 4096-byte chunks and sends them in a
loop with no delay between them. `sendMessage` treats any non-2xx as a plain
failure — a 429 is not retried and `retry_after` is not read.

Never exercised beyond a handful of messages. The first run after A1 drains
will produce a digest large enough to matter, and Telegram rate-limits a
single chat at roughly one message per second.

**Resolving it** means pacing between chunks and honouring `retry_after`.
Note the interaction with ADR-007: postings are marked notified only after a
successful send, so a 429 mid-digest currently means the whole digest is
re-sent next run, not that a chunk is lost.

---

## B4 — Jooble's API returns 403 regardless of key

**Status:** parked — investigated as far as reasonably possible, no path
forward found · **Found:** 2026-08-16 · **Closed off:** 2026-08-16

`POST https://jooble.org/api/{key}` returns 403 with a real registered key.
The decisive measurement is that it returns **byte-identical** 403s (4631
bytes) for a real key and for `00000000-0000-0000-0000-000000000000` —
from this machine and from Atlas, with the honest User-Agent and with curl's
default, and for `GET` as well as `POST`.

A response that does not vary with the key means nothing behind it has
evaluated the key.

This **falsifies the finding recorded in commit `d971c76`**, which read a
403 without Cloudflare markers as Jooble's application rejecting a bad key,
and concluded a valid key would get through. The absence of `cf-mitigated`
distinguishes less than it appeared to. `scripts/fixture-jooble.ts` now
records both probes and the correction.

> **Follow-up, 2026-08-16.** The obvious next step — log into
> `jooble.org/api/about`, confirm the key is active, and either read the
> documented request format or capture a working request from a live
> "try it" console via the browser's network inspector — was attempted and
> did not turn up a path forward. The account side offers nothing that
> explains a 403 identical for a real and a fake key; whatever is blocking
> this sits somewhere this project has no visibility into (the account, a
> plan restriction, an IP-range block, or the endpoint having moved).
>
> **Parked, not actively pursued further.** Forging a browser User-Agent to
> get past an unexplained block is not on the table (CLAUDE.md §6), and
> without a working request to observe, no fixture can be captured and no
> honest Zod schema can be written (CLAUDE.md §15 — do not invent a fact
> that can be checked, and this one currently cannot be). Worth noting while
> parking it: Jooble is an **aggregator** (`docs/02-architecture.md`'s
> source-topology table) — "high by construction" overlap with whatever it
> republishes, which for a Brazilian internship search likely means
> Gupy/CIEE postings a second time. Getting it working would also mean
> building the cross-source dedup layer `docs/02` already flags as
> necessary "the moment one [aggregator] is added" — real additional work,
> not just a fixture and a schema. That cost, on top of a block with no
> known fix, is why this is parked rather than escalated (e.g. a support
> ticket to Jooble) for now.
>
> `JOOBLE_API_KEY` stays in `.env`/`.env.example` and the fixture script
> stays in `scripts/` — inert, no cost to leaving them — in case the block
> resolves itself later (a plan change, a fixed endpoint) without this
> being revisited deliberately.

---

## C1 — Production run rows are permanently open

**Status:** open · **Found:** 2026-08-16, grown by one more the same day

Run `01M04JFMRPWY4660K4SBV97QBW` (`scoreAndDeliver`, started
2026-08-16T06:00:00Z) has `finishedAt: null` and `outcome: null`, because the
throw that killed it predates the fix in #49.

A second row joined it the same day: `01M055DMPHHE2RV05YK97Q5TA5`
(`scoreAndDeliver`, started ~11:30 UTC), the 6-hour backlog-draining run,
deliberately killed by a container restart once the maxAgeDays/cutover work
(#52/#53) made most of what it would have scored not worth scoring. #49's
fix only closes a row on a _throw inside the same process_; a hard restart
(the only way to cancel an in-flight run — no graceful drain exists) doesn't
give that code a chance to run at all. Killing a run this way always leaves
an open row behind, by construction, not as a bug.

While either exists, `GET /health` reports `lastSuccessfulRun.scoreAndDeliver`
as whatever the last row that actually finished was, and the open rows are
indistinguishable from a run genuinely still in progress.

**Resolving it** is a one-off `UPDATE` marking both `failed`. Left undone on
purpose: it is a manual write to the production database, and it should be a
deliberate act rather than a side effect of a deploy. Note that ADR-024 (A2)
does not touch this: it stops two runs from executing at once, which is a
different failure than a single run's process being killed mid-flight — a
restart will orphan a row exactly like this again, any time one is used to
cancel an in-flight run. Graceful cancellation (a way to actually stop a run
without killing the process) would be the real fix; not attempted here.
