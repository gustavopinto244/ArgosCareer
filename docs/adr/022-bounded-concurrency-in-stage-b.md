# ADR-022 — Run Stage B's requirement calls concurrently, bounded, warming the cache first

## Status

Accepted

## Date

2026-08-16

## Context

Stage B asks the model one question per requirement (`docs/04-scoring-model.md`,
ADR-005: per requirement, `met | partial | not_met`, with a mandatory evidence
quote). Requirements per posting run to roughly 25, which makes Stage B by far
the highest call volume in the pipeline — Stage A is one call per posting.

Until now those calls ran in a sequential `for` loop. That was never measured
against a real posting, because scoring had never once executed in production:
the prompt templates were missing from the container image, which
[PR #49](https://github.com/gustavopinto244/ArgosCareer/pull/49) fixed. The
first real end-to-end measurement, taken immediately after that fix against
`deepseek/deepseek-v4-flash-0731`:

|              |                                         |
| ------------ | --------------------------------------- |
| Calls        | 26 (1 Stage A + 25 Stage B)             |
| Duration     | **213.8 s** for one posting             |
| Cost         | $0.0026                                 |
| Prompt cache | 25 088 / 35 421 prompt tokens hit (71%) |

310 postings currently pass the pre-filter. Extrapolated, one pass over the
backlog is **≈ 18.4 hours** and ~$0.80.

The cost is irrelevant — that is ADR-016's whole point about the hosted model.
The wall-clock is not. ADR-009 schedules scoring and delivery into a nightly
off-peak window precisely so the model runs at one predictable time; a cycle
that starts at 03:00 and finishes in the evening makes that untrue, and it
collides with a scheduler that has no overlap guard
(`docs/11-known-issues.md` A2).

Two facts constrain the fix.

**The M7 calibration is thin.** 16 of 50 postings labelled, and the calibration
protocol's governing rule is one variable at a time. Anything that changes what
the model is asked invalidates the little calibration evidence that exists.

**Stage B's prompt is deliberately shaped around prefix caching.** ADR-013
reordered it so the large, per-run-constant `PROFILE_EVIDENCE` block comes
before the per-call requirement text, specifically so every Stage B call shares
a cacheable prefix. The 71% hit rate above is that decision working. Any change
here has to keep it.

## Considered options

### A — Batch every requirement into a single call

One call per posting instead of 25. The largest possible speedup, and the
largest possible change: the model would judge 25 requirements at once instead
of each in isolation, which is a different question with different failure
modes (attention dilution across a long list, inconsistent rigour between the
first and last item, and one malformed field discarding all 25 answers rather
than one). It needs a new prompt version, invalidates every cached Stage B
match, and invalidates the M7 calibration outright. Rejected **for now** — not
because it is wrong, but because it is a scoring-behaviour change that has to
be calibrated, and it cannot be evaluated honestly while the backlog is the
thing forcing the schedule.

### B — Bounded concurrency across requirements

Issue N requirement calls at once. Changes no prompt, no cache key, no
per-requirement isolation, and no output — the model is asked exactly the same
questions and gives exactly the same answers. Only the waiting overlaps.
Accepted.

### C — Cap postings per run and drain across nights

Purely operational, no code change to scoring. Does not fix anything: it makes
each night's run finish, while the backlog drains over a week and every
subsequent large intake re-creates the problem. Useful as a lever on top of B,
not as a substitute for it. Deferred.

### D — Concurrency across postings instead of requirements

Score several postings at once, each still sequential internally. Equivalent
throughput on paper, worse in practice: it multiplies peak memory by the number
of in-flight postings, interleaves database writes from several scoring flows,
and makes a failure mid-batch harder to attribute. Rejected.

## Decision

Stage B runs its requirement calls **concurrently, bounded** by
`scoring.stageBConcurrency` in `config/criteria.yaml`, default **8**.

Three properties are part of the decision, not incidental to it:

1. **Input order is preserved in the output.** Stage C and the digest read
   matches positionally against the requirement list. Answers settling out of
   order must not reorder results.
2. **The first requirement of each posting is issued alone**, before the
   fan-out. ADR-013's cacheable prefix is only worth anything if something
   populates it first; launching a cold prefix eight ways at once means eight
   misses, trading the cost lever away to buy the latency one. One warming call
   costs a few seconds per posting and keeps both.
3. **A failure stops further work.** The sequential loop returned on the first
   failed requirement; concurrency must not silently turn that into "ask all 25
   anyway". Calls already in flight settle, no new ones are issued, and nothing
   is cached — the cache key covers the full requirement set (ADR-007), so a
   partial entry would be indistinguishable from a complete one on the next
   read.

The bound lives in `criteria.yaml` rather than in code because it is an
operational dial that must be turnable without a deploy (principle 3, and
`docs/09-configuration.md`). It is the one value in the `scoring` block that is
**not** a Stage C input: it changes how long scoring takes and nothing about
what it produces.

## Consequences

**The nightly window becomes plausible again.** At concurrency 8 the expected
per-posting time drops from ~214 s toward ~30 s, and the backlog from ~18 h
toward roughly 2–3 h. Stated as an expectation, not a measurement: the real
number depends on provider latency under concurrency, which is exactly the
variable this changes. It must be measured on the first real run, not assumed
because it is written here.

**Cache hit rate will fall somewhat, and cost will rise somewhat.** The warming
call protects the common prefix, but calls within a batch still race each other
for anything cached beyond it. Going from 71% cached to, say, 50% moves the
backlog from ~$0.80 to perhaps ~$1.20. That is not a number worth defending.

**Concurrency is now a failure surface.** Rate limiting (HTTP 429) becomes
reachable in a way it was not sequentially. `OpenRouterClient` currently
treats any non-2xx as a plain failure, folded into
`parseModelOutputWithRetries`' bounded attempt budget, which means a 429 burns
retries rather than backing off. The default of 8 is modest partly for this
reason. If 429s appear, the fix is `retry_after`-aware backoff in the client —
the same gap `docs/11-known-issues.md` B3 records for Telegram — not a lower
bound here.

**Nothing about scoring output changes**, which is the point. Cached Stage B
matches stay valid, the prompt version stays `b-v2`, and the M7 calibration
remains as (in)valid as it was. Reversing this is a one-line change to the
config, or deleting the pool and restoring the loop — no migration, no
recalibration, no cache invalidation. That cheapness of reversal is the main
argument for doing B before A.

**Option A is still on the table and is now easier to evaluate.** Once the
backlog is drained and the nightly window is no longer the binding constraint,
batching can be tried against a calibration set as a deliberate one-variable
experiment, which is the only way it should ever be tried.
