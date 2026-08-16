# ADR-023 — A manual, permanent discard, independent of scoring and profile

## Status

Accepted

## Date

2026-08-16

## Context

Requested directly, alongside the age-limit work in ADR-011 Amendments 4–5:
a way to say "never show me this posting again" that survives editing
`config/profile.yaml` — which the profile owner expects to do often, adding
competencies as they're built and evidenced.

`Posting.notifiedAt` (M6, ADR-007) already marks "sent once, never again,"
but it is the wrong mechanism for this. It is set only on successful
delivery of an `apply`/`review` verdict, and a `discard` verdict never
touches it — by design, so the posting stays a candidate if the profile
later qualifies it. That design is exactly what this request needs _not_ to
happen for a posting the human has actively rejected: a discarded posting
must stay discarded through a profile edit, a new prompt version, or a
re-run, none of which should be able to resurrect a human "no".

The two decisions are opposite by nature. `notifiedAt` tracks a scoring
_outcome_, which is supposed to change when its inputs change. This tracks a
_human judgment_, which by definition does not depend on the scoring
pipeline at all — the profile can change fifty times and the posting is
still not wanted.

This is CLAUDE.md's "Feedback (Phase 2)" pulled forward in miniature: not
the learning loop that phase implies, just the one primitive it depends on
— a durable, out-of-band "no."

## Considered options

### Reuse or repurpose `notifiedAt`

Rejected outright. Conflating "sent in a digest" with "a human rejected
this" would make `findUnnotified()` (the digest candidate pool) unable to
tell the two apart, and would corrupt `notifiedAt`'s existing meaning for
every reader of it, including M10's market analysis.

### A generic `status` enum on `postings`

Considered: `active | notified | discarded | ...`. Rejected for now — it
would mean migrating `notifiedAt`'s existing meaning into the enum too, a
larger and riskier change than this request asked for, and the two facts
("was this delivered" and "did a human reject this") are not mutually
exclusive in an enum's usual sense: nothing stops a posting from being both,
if a human discards something after already having seen it delivered.
Two independent nullable columns model that correctly; a single enum would
have to either forbid the combination or grow a compound state space.

### Support "undiscard"

Rejected. A discard is meant to be a considered, rare, deliberate act —
adding a reversal path is exactly the kind of machinery CLAUDE.md warns
against building for a case that has not happened yet. Reversing a bad call
means a direct database edit, which is honest about how rare it should be
rather than papering over it with an API that would need its own audit
trail to be trustworthy.

### Exposed only through Telegram (bot commands / inline buttons)

Rejected. `TelegramNotifier` is deliberately a "dumb," send-only client
(CLAUDE.md §10) — the boundary decision that keeps the nightly digest
working even with Hermes and its whole machine unreachable. Building
interactive bot-command handling to support a discard button would
reintroduce exactly the kind of critical-path dependency that boundary
exists to avoid, for one feature.

### CLI, REST, and MCP, backed by one repository method (chosen)

Matches the pattern `RunsService`/`RunsController`/`McpController` already
established for stage re-execution: one core implementation
(`PostingsRepository.discard`), three thin callers. The API and MCP path
mean Hermes — the actual "personal assistant" surface this system is meant
to be used from day to day — can discard a posting directly; the CLI path
means it can be done by hand on Atlas without going through the network
boundary at all.

## Decision

`postings` gains two nullable columns: `discardedAt` (timestamp) and
`discardReason` (free text, optional). `PostingsRepository.discard(
fingerprint, discardedAt, reason)`:

- **Write-once**, the same discipline `firstSeenAt` and `notifiedAt` already
  follow: a fingerprint already discarded is left untouched by a second
  call, both timestamp and reason. Returns `true` either way (the posting
  exists) or `false` only when the fingerprint genuinely does not exist —
  distinguishing those two is a second `SELECT`, cheap and worth it so a
  caller's "not found" is accurate rather than ambiguous with "already
  discarded."
- **Survives re-collection.** A source re-listing the same posting under the
  same fingerprint must not silently un-discard it — verified the same way
  `notifiedAt`'s equivalent guarantee is verified.

`findUnnotified()` — the digest's candidate pool — excludes a discarded
posting the same way it excludes an already-notified one. A discarded
posting is otherwise untouched: still stored, still visible to `findActive`,
still counted by M10's market analysis over the whole corpus
(`docs/05-domain-model.md`'s "nothing is ever deleted," ADR-007).

`discardedAt`/`discardReason` are deliberately **not** added to the
`Posting` domain interface. Nothing downstream of the pre-filter needs to
know a posting was discarded — the repository query already removed it from
consideration before anything else runs — so adding the fields to the
domain type would be plumbing for a fact no consumer reads.

Three equivalent entry points, one implementation:

- `PostingsRepository.discard` directly, via `argos discard <fingerprint>
[--reason <text>]` (CLI, for Atlas).
- `POST /postings/:fingerprint/discard` (REST, `PostingsController` +
  `PostingsService`), 404 on an unknown fingerprint.
- `discard_posting` (MCP tool), the path Hermes actually uses.

## Consequences

**Easy:** a posting rejected once stays rejected regardless of how many
times the profile changes afterward — the concrete problem this was asked
to solve. Reversible in the cheap sense that matters (delete the two
columns, or ignore them) and irreversible in the sense that matters more:
there is no accidental or automated way to undo a human's "no."

**Hard:** there is genuinely no undo without a direct database write. That
is the deliberate cost of treating this as a rare, considered act rather
than a feature with its own management surface — worth naming plainly
rather than discovering the first time someone wants one back.

**A boundary worth restating:** this is not the Phase 2 feedback loop
CLAUDE.md's milestone table describes — no signal from a discard feeds back
into scoring weights, track classification, or anything the pipeline
learns from. It is the one primitive that loop would eventually need,
built now because it was asked for directly, not a down payment on building
the rest of it.
