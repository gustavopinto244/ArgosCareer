# ADR-033 — A durable, five-state checkpoint for the Catho collector

## Status

Accepted

## Date

2026-08-17

## Context

A repository audit (`docs/audit/AUDIT_REPORT.md`, findings AC-001 and
AC-002 — both rated CRITICAL) found two real data-loss bugs in
`collectors/catho/collect.ts`, confirmed by reading the code rather than
inferred:

- **AC-001**: every candidate ID resolved this run — whether its posting
  was actually ingested or not — was added to `seenIds` and saved
  **before** the POST to `/runs/collect/external` was even attempted. A
  network failure, a `409` (the app's own `RunLock` busy with a concurrent
  collect), a timeout, a `5xx`, or the process being killed between
  collection and ingest meant that entire batch was marked done and never
  retried, even though nothing had reached the database.
- **AC-002**: `collectOne` returned `null` — folded into "expired" by the
  caller — for four different situations: a missing response, any non-2xx
  status, a redirect away from the posting's own URL, and missing/invalid
  JSON-LD. Confirmed live during the pre-deploy audit
  (`docs/audit/AUDIT-PRE-DEPLOY-2026-08-17.md`): Playwright's default
  headless Chromium gets a `403` from Catho — the exact case this code
  recorded as a normal, terminal "posting expired."

Both bugs are about **Catho specifically**, not the receiving side —
`catho-schema.ts`/`catho-normalizer.ts` and their registration in
`normalizer-registry.ts` are unaffected and untouched here.

Separately, the same pre-deploy audit found Catho's headless browser gets
blocked outright (403, 0/10 real pages collected in a live test) — a
different, unresolved problem. **This ADR does not fix that.** The
checkpoint semantics below are correct and worth having independent of
when — or whether — that block is resolved; `collectors/catho/README.md`
and this collector's own module doc now say plainly not to build/schedule
it on Atlas until it is.

## Considered options

### Patch the existing flat seen-ID set (e.g., a second "confirmed" set)

Rejected: a second parallel `Set<string>` for "actually ingested" still
conflates every failure reason into one bucket (AC-002's problem) and adds
state without a clear single source of truth for what each ID's status
actually is.

### A full event log (append-only) of every attempt

Considered — gives perfect history. Rejected for now: this script has no
database, only a flat file on a bind-mounted volume; an unbounded
append-only log needs its own retention/compaction story, which is real
scope beyond what a data-loss fix needs. The state file's `failCount`
already answers "how many times has this failed," which is what the
retry/quarantine logic actually needs.

### A five-state-per-ID map, in one JSON file (chosen)

`collectors/catho/state.ts`: every ID is `collected` (payload fetched and
held durably, ingest not yet confirmed), `ingested` (confirmed by a 2xx
from the API — terminal), `expired` (confirmed by the one specific pattern
that has actually been observed — terminal), `retryable` (a failure that
should be retried, with a `failCount`), or `quarantined` (5+ consecutive
retryable failures — stops being retried automatically, but stays in the
file, visible, not silently dropped forever).

## Decision

`classifyPageResult` (pure, no Playwright dependency, fully unit-tested —
27 tests in `state.test.ts`) turns the raw signals `collect.ts` observes
(HTTP status, final URL, parsed JSON-LD, page title) into exactly one of
three outcomes:

- **`collected`** — a 2xx response, not on the generic listing page, with
  parseable JSON-LD.
- **`expired`** — a 2xx response whose final URL is exactly `/vagas` or
  `/vagas/`, the one pattern actually confirmed live (a real expired
  posting redirecting to the generic listing). Nothing else counts —
  specifically not any other redirect, and not any non-2xx status, which
  is the direct fix for AC-002.
- **`retryable`** — everything else: no response (network error/timeout),
  any other non-2xx (429, 403, 5xx, 404, ...), or a 2xx with missing/invalid
  JSON-LD. Each retryable outcome increments a fail count; at 5 consecutive
  failures for the same ID, it moves to `quarantined` instead of retrying
  forever.

`main()` in `collect.ts` now runs two passes: first, every ID currently
`collected` (this run's fresh fetches, plus any left over from a previous
run whose ingest never succeeded) is gathered into one ingest batch —
_independent of whether that ID still appears in today's sitemap scan_.
The state file is saved **atomically** (write to a temp file, then
`rename`, per AC-001's "gravação do state atômica e recuperável após
interrupção") immediately after the browser phase, before the ingest POST
is even attempted — so a payload is durable on disk the moment it is
fetched, not only after a successful send. `markIngested` — the only
function that can move an ID to `ingested` — is called strictly after a
confirmed 2xx from `/runs/collect/external`; any other outcome (network
failure, 409, 429, 5xx) leaves those IDs `collected`, retried on ingest
alone (no page reload) by the next scheduled run.

## Consequences

**Easy:** the fix is entirely inside `collectors/catho/` — no change to
the main app, the ingest endpoint, or the schema/normalizer. `state.ts` is
a small, pure module, fully testable without Playwright or a real HTTP
call, which is also why it now has a real test suite where none existed
before (`docs/audit`'s own finding: "Não há testes do script Catho").

**Hard:** the state file's shape changed (flat `string[]` → `{version, entries}`
map) and its default path changed
(`catho-seen-ids.json` → `catho-state.json`, env var `SEEN_IDS_PATH` →
`STATE_PATH`). `loadState` treats the old format as unparseable and starts
fresh rather than migrating it — acceptable because Catho has never
actually run in production (confirmed: 0 real deploys, per both audits),
so there is no real backlog progress to lose. This would need a real
migration path if it ever did have production history.

**Deliberately not solved here, matching REMEDIATION_PLAN.md §4's own
scoping:** no idempotency key on the ingest POST itself (the server-side
fingerprint upsert already makes re-sending the same batch safe, so this
was judged unnecessary rather than overlooked); no in-process wait/retry
on a `409` (the systemd timer's 30-minute cadence already serves as the
retry mechanism, consistent with how `collectors/indeed` relies on its own
timer rather than an in-process retry loop).

**Reversal cost:** low. `state.ts` has no dependents outside
`collect.ts`; reverting means restoring the old flat-set logic and
deleting `state.ts`/`state.test.ts`. The old state file format is gone
either way (see Hard), but there was never any real data in it.
