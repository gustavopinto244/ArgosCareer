# ADR-046 — Rate-limit the shared API key, enforced once regardless of protocol

## Status

Superseded by ADR-047

## Date

2026-08-17

## Context

ADR-017 gave the M9 HTTP/MCP boundary one fixed Bearer key, checked with a
timing-safe comparison, applied globally — "one trusted consumer, simple to
audit," with Cloudflare Access/JWT named as the upgrade path "if a second
consumer or public exposure ever arrives, not built now." That trade-off
still holds: this is a personal project with one operator behind every
caller (n8n, host-side collectors, Hermes) that shares the key.

What ADR-017 did not address, and a post-remediation audit (`docs/audit`,
AC-021) named directly: the key authorizes real side effects with no rate
ceiling at all. `POST /runs/deliver` spends real OpenRouter budget and
sends a real Telegram message; `POST /runs/collect/external` accepts up to
a 10 MB batch (ADR-027) that gets written to the database. `RunLock`
(ADR-024) stops two `deliver` runs from overlapping, but says nothing
about a leaked key calling `deliver` in a tight sequential loop — each
call waits for the previous one's lock to release, then runs again,
accumulating real cost with nothing to slow it down.

## Considered options

### Split the shared key into per-caller credentials with individual scopes

The audit's fuller recommendation. Rejected for now, for the same reason
ADR-017 rejected Cloudflare Access/JWT at M9: real work (issuing, storing
and rotating multiple credentials; a scope model to design) for a threat
this project does not face yet — every caller is this project's own
automation, run by the same operator, not a genuinely different party
needing to be told apart from another. Revisit under the same trigger
ADR-017 already named.

### `@Throttle` decorators on `RunsController`'s routes alone

Tried first, then reconsidered. `ThrottlerGuard` operates per HTTP route,
and `collect`/`deliver`/`ingestExternal` are each reachable two ways:
`RunsController`'s REST routes, and `McpController`'s tools — all of which
share **one** HTTP route (`POST /mcp`), the MCP protocol's own multiplexed
transport. A decorator on `RunsController.deliver()` protects
`POST /runs/deliver` and is completely invisible to a `run_deliver` MCP
tool call, which is arguably the more likely path in practice — Hermes,
the consumer M9 was built for (`CLAUDE.md` §10), speaks MCP, not raw REST.

### One shared check in `RunsService`, using the throttler's own storage directly (chosen)

`RunsService` is the one place both `RunsController` and `McpController`
already call — its own doc comment says so: "every tool calls the same
`RunsService` method... so 'run collect' has exactly one implementation
regardless of which of the two protocols Hermes speaks." Rate limiting
follows the same principle: enforced once, there, not duplicated per
transport.

## Decision

**Two layers, different scope:**

- **`ThrottlerGuard`**, a second global `APP_GUARD` registered after
  `ApiKeyGuard` (guard order matters: an unauthenticated request is
  rejected before it can consume rate-limit budget), gives every route a
  generous default ceiling (`DEFAULT_THROTTLER_LIMIT`/`_TTL_MS`,
  `throttler-limits.ts`) — ordinary protection against a wayward or
  compromised caller hammering any endpoint, `GET /runs` included.
- **`RunsService.enforceExpensiveOperationLimit(operation)`**, called at
  the top of `collect`/`deliver`/`ingestExternal`, injects `@nestjs/
throttler`'s own `ThrottlerStorage` directly (the same in-memory store
  `ThrottlerGuard` itself uses) and calls `.increment()` by hand, keyed
  `expensive-operation:<name>` — one budget per operation, shared across
  both protocols, throwing `ThrottlerException` (429) past
  `EXPENSIVE_THROTTLE.limit` (3) within `EXPENSIVE_THROTTLE.ttl` (10 min).
  `McpController`'s existing `safely()` wrapper already turns any thrown
  exception into an `isError` tool result — no new error-handling path
  needed on the MCP side.

Limits sized against real usage, not picked arbitrarily: the nightly
scheduler calls `collect`/`deliver` at most once per cycle (ADR-009), and
a host-side collector timer fires at most a few times a day — three calls
in ten minutes is already several multiples of any legitimate pattern.

## Consequences

- **Closes the gap for both protocols with one implementation**, matching
  the project's existing "one method, two transports" discipline for
  `RunsService` rather than adding a second, HTTP-only mechanism that
  would have left MCP unprotected.
- **In-memory, not persisted.** A process restart resets every counter —
  acceptable for a rate limit (the point is smoothing a burst, not an
  audit trail) but worth naming: restarting the container is, incidentally,
  a way to clear a budget currently blocked, same as it would be for any
  in-memory limiter.
- **Does not distinguish which caller** hit the limit — n8n, a collector
  and Hermes all draw from the same per-operation budget, since they share
  one key. Consistent with this ADR's own scope decision (bounding blast
  radius from one shared secret, not attributing usage to a specific
  legitimate caller) — the per-caller version of this question is exactly
  what the rejected "split the key" option would answer, deliberately not
  attempted here.
- **Reversal cost:** low. Deleting the `enforceExpensiveOperationLimit`
  calls and the `ThrottlerModule` import/guard registration fully reverts
  this; `@nestjs/throttler` becomes an unused dependency, removable in the
  same change.
