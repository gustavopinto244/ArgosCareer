# ADR-048 — Checkpoint Telegram delivery with manual reconciliation

## Status

Accepted

## Date

2026-08-17

## Context

A digest may exceed Telegram's message limit and be sent as several chunks.
Previously, process failure after one accepted chunk caused the next run to send
the entire digest again. Timeouts and lost acknowledgements are harder: after a
request leaves this process, a failure cannot prove whether Telegram accepted
it. Telegram `sendMessage` offers no caller-supplied idempotency key, so the
application cannot promise exactly-once delivery.

The checkpoint must survive process restarts, prevent concurrent workers from
sending the same operation, bind state to the exact rendered content, and avoid
automatically repeating an ambiguously acknowledged chunk.

## Considered options

### Retry the whole digest and accept duplicates

Rejected for digest delivery. It is simple, but turns every later-chunk failure
into duplicate messages already known to have succeeded.

### Treat every timeout or transport error as a definite failure

Rejected. Retrying automatically may duplicate a message that Telegram
accepted before the acknowledgement was lost.

### Persist per-chunk checkpoints and reconcile ambiguity manually (chosen)

This preserves confirmed progress and makes the unavoidable uncertainty
explicit instead of pretending the remote API has exactly-once semantics.

## Decision

SQLite stores a `delivery_operations` row keyed by the destination and a hash
of the exact rendered digest, plus ordered `delivery_chunks` containing each
body and its hash. A worker must atomically claim the operation through a
bounded lease before sending. Chunks move through `pending`, `sending`,
`failed`, `uncertain`, and `confirmed`.

A successful Telegram acknowledgement is accepted only when it has `ok: true`
and an integer `message_id`; then the chunk is confirmed and never sent again.
A definitive Telegram rejection records `failed` and may be retried from that
chunk. Network failures, timeouts, 5xx responses, malformed acknowledgements,
and a crash while `sending` remain ambiguous and stop automatic progress.
`argos reconcile-delivery` requires the operator to mark such a chunk
`confirmed` (optionally recording a message id) or explicitly authorize
`retry`, accepting the duplicate risk.

An operation is completed only after every chunk is confirmed. Retrying an
operation whose chunks were all confirmed but whose final completion write was
interrupted performs that finalization without contacting Telegram. Content or
chunk-layout mismatches under an existing operation identity fail closed.

Short operational `sendText()` alerts remain outside this mechanism; the
durability guarantee applies to rendered digest delivery only.

## Consequences

- Confirmed chunks survive restart, and definite failures resume from the first
  unconfirmed chunk instead of duplicating the whole digest.
- Ambiguous failures now require operator work. That pause is intentional: no
  local algorithm can infer the remote outcome safely.
- Leases allow stale-worker recovery but do not make Telegram transactional.
  An operator authorizing retry may still create a duplicate.
- Rendered content becomes part of delivery identity. Deliberately sending an
  identical digest to the same destination again requires an explicit product
  decision or a new identity dimension.
- The schema and reconciliation command add persistent operational state. A
  different transport with native idempotency could simplify the adapter, but
  migrating existing checkpoints would still need care.
