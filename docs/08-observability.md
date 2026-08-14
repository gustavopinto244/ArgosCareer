# 08 — Observability

## The problem this exists to solve

Principle 1 says a broken source degrades the digest instead of cancelling it.
`docs/02-architecture.md` already admits the cost: **a silently empty source
looks identical to a source with no matching postings.**

That is a failure mode the architecture deliberately creates. Without something
watching, the Gupy adapter can break on a Tuesday and the first symptom is
noticing, weeks later, that the digest has been thin. For a system whose whole
purpose is to stop job postings from being missed, silent degradation is the
worst possible failure.

Observability here is not operational polish. It is the counterweight to
principle 1.

## Logging

Pino, JSON to stdout, integrated with journald under systemd — the same setup as
`atlas-manager`.

### Levels, and what each means

| Level   | Meaning                        | Example                                                                    |
| ------- | ------------------------------ | -------------------------------------------------------------------------- |
| `error` | The run could not do its job   | Digest delivery failed                                                     |
| `warn`  | Degraded but continuing        | A source returned an error; scoring failed for a posting after all retries |
| `info`  | Run lifecycle and stage totals | Run started, 47 collected, 12 after dedup, 4 scored                        |
| `debug` | Per-posting decisions          | Why one posting was filtered out                                           |

**`warn` is the interesting level.** Everything that principle 1 lets the
pipeline survive lands here, which makes "warnings in the last week" the question
worth asking.

### Every log line carries the run

```
runId        ULID, one per pipeline execution
stage        collect | normalize | dedup | prefilter | score | deliver
source       when the line concerns one source
fingerprint  when the line concerns one posting
```

`runId` is what makes a batch reconstructable after the fact. Without it, logs
from a daily collection and a Friday delivery interleave in journald and cannot
be told apart.

**No personal data in logs.** No profile text, no evidence quotes, no recruiter
contact details. Logs go to journald on a server and get read casually; ADR-004's
boundary applies to them exactly as it applies to the repository. A posting is
identified by fingerprint and title, never by its full description.

## The `runs` record

Principle 2 — every stage independently re-runnable — needs state, and this is
where it lives. Designed in M4 alongside the schema; recorded here because it is
what makes both principle 2 and the alerting below possible.

Per run: `runId`, kind, started/finished timestamps, outcome, and per-stage
counts — collected, rejected in normalization, deduplicated, filtered out,
scored, failed to score, delivered.

Those counters are not decoration. They are the input to every alert below, and
the evidence for the "~70% pre-filter" estimate that `02-architecture.md`
currently carries as an unverified guess.

## Alerting

Delivered through the same Telegram notifier as the digest. A separate alerting
channel for a personal project would be infrastructure nobody maintains.

| Condition                                              | Why it matters                              | Action                       |
| ------------------------------------------------------ | ------------------------------------------- | ---------------------------- |
| A source returns **zero postings** on consecutive runs | The canonical silent failure of principle 1 | Alert naming the source      |
| A source **errors** on consecutive runs                | Adapter broken or blocked                   | Alert with the error         |
| **Scoring failure rate** above threshold               | Model or prompt regression (ADR-006)        | Alert with the rate          |
| A run **did not start** when scheduled                 | Scheduler or container down                 | Alert on next successful run |
| Delivery failed                                        | The product did not reach the user          | Retry, then alert            |

**Consecutive, not single.** A source returning nothing on one run is normal — a
quiet Tuesday is not an incident. Alerting on single runs trains you to ignore
alerts, which is worse than not having them.

### The run summary is the everyday signal

Every digest ends with its run summary: collected, deduplicated, filtered,
scored, failed, plus any source that errored. This is what makes principle 1
honest — a source that failed is _visible in the product_, not merely absent from
it.

Most degradation gets noticed here, by a human reading a digest they were going
to read anyway, before any alert threshold trips. The alerts above are the
backstop for when nobody is reading.

## Health and metrics

**No Prometheus, no dashboards, no metrics backend.** The budget is ~150 MB at
rest on a server already running four other things, and a metrics stack would
cost more than the application it watches.

The `runs` table is the metrics store. Questions like "how many postings did the
pre-filter cut last month" are SQL queries against data that has to exist for
principle 2 anyway.

M9 adds an HTTP health endpoint reporting last successful run per kind, which is
what an external check — including Hermes — can poll.

## What is deliberately not done

- **Distributed tracing.** One process, sequential stages. `runId` in every log
  line is the whole requirement.
- **Log shipping.** journald on Atlas, read over SSH. Shipping logs off the box
  means another service to run and secure.
- **Alerting on latency.** A batch that takes twenty minutes instead of ten is
  not a problem; a batch that does not finish is, and that is covered by the
  missing-run alert.
- **Paging.** There is nobody on call. Every alert here is a Telegram message
  that can wait until morning.
