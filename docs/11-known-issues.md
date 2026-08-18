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
>
> **Checked against a real run, 2026-08-17 — still not the number this
> entry is waiting for.** The most recent real `scoreAndDeliver` run
> scored 40 postings in 830.9 s, but 34 of those 40 read a cached Stage A
> extraction rather than calling the model — see A3's matching note. A
> mostly-cached run cannot stand in for "the backlog," which is by
> definition mostly cold. Stays open.

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

> **A real run measured, 2026-08-17 — still not the measurement this entry
> needs.** Queried Atlas's production database directly: the most recent
> real `scoreAndDeliver` run (`01M05CE3730E1V91P2APN78XG9`) scored 40
> postings in 830.9 s (~20.8 s/posting average) — much faster than this
> entry's 40–67 s/posting Stage A estimate. Checked why before trusting
> it: only **6 of the 40** postings got a _new_ Stage A extraction during
> the run's window; the other extractions it read already existed
> (ADR-007's per-fingerprint cache), most of them from earlier work (M7
> calibration and similar). **The average is fast because it is mostly
> cache hits, not because cold Stage A got cheaper.** This run still does
> not answer what this entry is actually asking — real Stage A cost at
> backlog scale, mostly cache _misses_. That measurement has not happened
> yet. Left open.

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

**Status:** fixed, pending confirmation against a real failure · **Found:**
2026-08-16, trying to explain a collect run

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

> **Resolution, 2026-08-17.** Four columns added to `runs`
> (`too_old_count`, `unnormalizable_count`, `failure_reason`,
> `failed_sources` — migration `drizzle/0010_amused_winter_soldier.sql`,
> additive only, no backfill for existing rows). `executeCollect` now
> writes all four on both the normal-finish and the caught-exception path;
> `failedSources` is a `Set<string>` built from every point that already
> knew which source it was looking at (no collector registered, a
> collector-reported error, an unregistered normalizer), serialized to
> JSON text (`parseFailedSources` reads it back), the same manual
> serialize/parse precedent `requirements`/`matches` already use rather
> than a new drizzle json-mode column.
>
> **The second symptom is also fixed:** `executeDeliver`'s `failedSources`
> was hardcoded to `["gupy"]` regardless of which source actually failed.
> It now unions `parseFailedSources` over every `collect` run in the
> delivery window — a real per-source breakdown, not a guess.
>
> **Not yet observed against a real failure in production** — covered by
> unit tests (`test/persistence/runs-repository.test.ts`,
> `test/cli/main.test.ts`) exercising the exact `collectedCount: N,
normalizedCount: 0` scenario this entry describes, but the real value is
> reading an actual failed run's row on Atlas once one occurs.

---

## B3 — Telegram delivery has no pacing and no 429 handling

**Status:** fixed, pending confirmation against a real large digest ·
**Found:** 2026-08-16, sizing the digest A1 will produce

`TelegramNotifier` splits a digest into 4096-byte chunks and sends them in a
loop with no delay between them. `sendMessage` treats any non-2xx as a plain
failure — a 429 is not retried and `retry_after` is not read.

Never exercised beyond a handful of messages. The first run after A1 drains
will produce a digest large enough to matter, and Telegram rate-limits a
single chat at roughly one message per second.

> **Resolution, 2026-08-17.** `TelegramNotifier` now paces every chunk after
> the first by `pacingMs` (default 1,100 ms — over Telegram's stated ~1
> msg/s/chat limit on purpose, not exactly at it) before sending, and
> retries a `429` up to `maxRetries` (default 3) times, sleeping
> `retry_after` (parsed from Telegram's real response shape,
> `parameters.retry_after`, in seconds) before each retry, capped at
> `retryAfterCapMs` (default 30 s) against a malformed or unexpectedly
> large stated value. A `429` with no parseable `retry_after` falls back to
> a conservative 5 s wait rather than retrying immediately. Only `429` gets
> this treatment — a plain `5xx` still fails on the first non-2xx response,
> unchanged, per the existing "stops sending further chunks once one chunk
> fails" contract.
>
> The ADR-007 interaction this entry named is preserved exactly: retries
> happen _within_ one `sendMessage` call, so exhausting them still means
> the whole digest is marked undelivered and re-sent next run, not that a
> chunk is lost silently.
>
> Covered by fake-timer tests (`test/delivery/infrastructure/telegram-notifier.test.ts`)
> — pacing actually delays the next chunk, a `429` retries and succeeds
> once `retry_after` elapses, retries are bounded, a missing `retry_after`
> falls back to the default, and an excessive one is capped. **Not yet
> exercised against Telegram's real API** — no test here claims to know
> Telegram's actual rate-limit behavior beyond its documented response
> shape.
>
> **Follow-up, 2026-08-17 (docs/audit AC-022).** A post-remediation audit
> found the one piece this entry's own fix left open: `fetch` had no
> timeout at all. A hung TCP connection (not an HTTP error Telegram
> itself returns) could hold the delivery run's `RunLock` open
> indefinitely, blocking every later scheduled run behind it — worse than
> the "re-sends whole digest next run" cost this entry already accepted
> as an ADR-007 trade-off. `TelegramNotifier` now wraps every
> `sendMessage` attempt in an `AbortController` timeout (`timeoutMs`,
> default 20 s), the same pattern `GupyCollector`/`OpenRouterClient`
> already use.
>
> **Second follow-up, 2026-08-17 (ADR-048): AC-022's remaining delivery
> gap is implemented.** Digest chunks now have durable operation/chunk
> checkpoints keyed by destination and rendered-content hashes. A valid
> Telegram success acknowledgement must contain `ok: true` and an integer
> `message_id`; confirmed chunks survive restart and are skipped on retry.
> Definite failures resume from the failed chunk. Ambiguous failures
> (network/timeout/5xx/invalid acknowledgement, including a crash after send
> before confirmation) stop in `uncertain`/`sending` and require the explicit
> `argos reconcile-delivery` command to mark the chunk confirmed or authorize
> a retry. This provides resumability without falsely promising exactly-once
> delivery from an API that has no caller-supplied idempotency key. Restart,
> lease takeover, manifest mismatch and partial retry are covered against a
> real temporary SQLite database. A live ambiguous Telegram failure has not
> been manufactured in production; short `sendText()` alerts remain outside
> the durable digest path and are documented as such.

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

## B5 — Three hot-path inefficiencies, measured against a corpus that hasn't grown into them yet

**Status:** bounded and optimized; production speedup not yet benchmarked ·
**Found:** 2026-08-17, a post-remediation audit (docs/audit AC-032) ·
**Implemented:** 2026-08-17 (ADR-050)

Three separate spots do more work than they need to, none yet a real cost
at this project's current corpus size:

- **Stage B re-reads and re-renders on every requirement.**
  `buildStageBPrompt` (`prompts.ts`) calls `loadTemplate` — a synchronous
  `readFileSync` — and rebuilds the full profile evidence catalog
  (`buildEvidenceCatalog`/`formatEvidenceCatalog`) from scratch, once per
  requirement. A 25-requirement posting does this 25 times for output
  that would be identical within one `match()` call, if not for
  `evaluatedAt` being captured fresh per requirement rather than once for
  the whole call (`stage-b-matcher.ts`'s own comment explains why: two
  provenance checks within _one_ requirement's prompt must agree on "what
  time is it," not that every requirement in a posting needs to).
- **Layer-2 dedup is O(n²) in the worst company group.**
  `dedupSimilarPostings` (`dedup-similar-postings.ts`) compares each
  candidate against every earlier posting already `seen` in its company
  group via `.find()` — fine at this project's per-company posting
  counts, not fine for a single employer with thousands of listings.
- **Upsert and notification are per-item**, not batched — a
  select-then-write-then-select per posting, a mark-notified call per
  posting delivered.

**Resolution, 2026-08-17.** The changes are semantic-preserving bounds and
elimination of repeated work, not a claimed benchmark win:

- prompt templates are cached by resolved path and Stage B renders the
  invariant evidence prefix once per posting; one `evaluatedAt` now owns the
  profile hash, prompt, provenance checks and cache timestamps;
- layer-2 comparison is capped at 500 recent in-window postings per candidate,
  and `comparisonTruncatedCount` makes every activation of that cap visible;
  layer 2 is shadow-only, so truncation cannot suppress a posting;
- collection uses one transaction per query/batch and notification updates
  delivered fingerprints together, while retaining the existing upsert and
  write-once semantics.

Regression tests prove output/order/cache and persistence behavior. No
wall-clock or fsync benchmark has yet been run on the production corpus, so
this entry does not claim a measured latency improvement. Revisit measurement
when `comparisonTruncatedCount` becomes nonzero, collection volume grows, or
A1/A3 receive their cold-cache backlog benchmark.

---

## B6 — Stage A/B's LLM call failure rate was 70% on the 2026-08-17 calibration run

**Status:** transport remediation implemented; production validation pending ·
**Found:** 2026-08-17, calibration run `01M09542FFR83M5V8HPSAQ68F3`

`runs.llm_outcome_counts` for that run: 125 attempts, 37 `success`, 31
`timeout`, 57 `invalidOutput` ("Unexpected OpenRouter response shape"), 0 of
every other category. Only 5 of the 28 pre-filter-passing postings finished
scoring; the rest fell back to the `lowConfidence` review path (ADR-006),
which is why most of that run's digest read "⚠ Não foi possível pontuar
automaticamente" instead of a real score.

Not investigated further this session — out of scope for the pre-filter
work ADR-051 covers, and the pre-filter changes in ADR-051/Amendment 1
(28 → 6 pre-filter passes) mean the next calibration run pays for far fewer
Stage A/B calls, which will itself shrink the sample this was measured on.
Worth root-causing if it recurs: candidates not yet checked are
`LLM_MODEL`'s actual output shape against what `openrouter-client.ts`
expects, whether `timeout` (30s) is short for this model specifically, and
whether the 57 `invalidOutput` failures cluster on particular postings
(retried into a different failure each time, per the transcript) or are
uniform across the batch.

**Planned check, 2026-08-18:** re-run `argos deliver` after a fresh
`collect`, then compare `runs.llm_outcome_counts` against this entry's
125/37/31/57 split. If the failure rate holds, it is a systemic issue with
the model/client pairing, not one-run noise, and should get its own ADR.

> **Follow-up, 2026-08-18.** The planned check recurred on production run
> `01M09Q92RQQF91PDS6YVD1FB4J`: 3 postings passed the pre-filter, only 1
> scored, and 23 OpenRouter attempts split into 9 transport-level successes,
> 4 timeouts and 10 `invalidOutput` responses. The two failed postings both
> stopped in Stage A after four attempts and had already failed the same way
> on the preceding run, with the same `a-v4`/`b-v4` prompts and configured
> model. This confirms a recurring model/client/provider problem, but does
> not support a prompt-regression diagnosis. Full evidence, limitations and
> prioritized remediation are recorded in
> [`docs/audit/SCORING-INCIDENT-2026-08-18.md`](audit/SCORING-INCIDENT-2026-08-18.md).

> **Remediation, 2026-08-18 (ADR-052).** The client now recognizes OpenRouter's
> documented top-level and choice-level HTTP 200 error envelopes, classifies
> canonical `error_type` values, opts into router metadata and persists only
> content-free stage/provider diagnostics. Stage A uses 120 s / 2,048 tokens;
> Stage B uses 30 s / 768 tokens. Run rows retain stage/outcome, provider,
> error-type and score-failure counts. The old alert was split: every missing
> score reports digest impact, while an accounted operation-rate signal needs
> at least 10 attempts and no longer claims a prompt/model regression. Raw
> response-body logging was removed. Unit/integration coverage is complete;
> a cold-cache production run is still required before this issue can be
> called operationally closed.

---

## C1 — Production run rows are permanently open

**Status:** fixed (the two known rows), the underlying gap stays open ·
**Found:** 2026-08-16, grown by one more the same day

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

> **Resolution, verified 2026-08-17.** Queried Atlas's real production
> database directly (`docker exec argos-career node -e '...better-sqlite3...'`,
> read-only, not the app's own API) rather than trusting this entry's
> age: both rows already carry `finishedAt`/`outcome: "failed"`, both with
> the identical timestamp `2026-08-16T13:17:48Z` — the fingerprint of a
> single bulk `UPDATE`, exactly the deliberate one-off act this entry
> called for. It had already happened by the time this was re-checked;
> this entry was simply never updated to say so. `SELECT ... WHERE
finished_at IS NULL` against the live database returns zero rows as of
> this check.
>
> **The underlying gap is genuinely still open, not just this entry's
> staleness:** a hard restart mid-run still orphans a row exactly this way,
> with no graceful cancellation to prevent it. The next occurrence needs
> the same deliberate manual fix — this entry stays, minus the two now-closed
> rows, as the runbook for doing it again.
