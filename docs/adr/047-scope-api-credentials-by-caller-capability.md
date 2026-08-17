# ADR-047 — Scope API credentials by caller and capability

## Status

Accepted

## Date

2026-08-17

## Context

ADR-017 and ADR-046 assumed one trusted operator and one shared Bearer secret.
That stopped anonymous access and bounded bursts, but it made every legitimate
caller an administrator. A credential copied to a host-side source collector
could permanently discard postings, invoke unrelated sources, or spend model
and Telegram budget. The shared rate-limit key also made one caller consume
another caller's allowance, and `runs` could not attribute work without storing
the secret itself.

The current callers have stable, narrow roles: administration, operational
automation, and external ingestion for one named source. This does not require a
general user/role system, a token issuer, or public identity infrastructure.

## Considered options

### Keep one shared credential and rely on network isolation

Rejected. Tailscale and Cloudflare reduce reachability, but a secret still
crosses process and host boundaries. Network location does not constrain what a
leaked collector credential can do after authentication.

### Adopt JWT/OAuth or Cloudflare Access identities

Deferred. They provide richer identity and rotation, but add an issuer,
verification keys and operational dependencies that are disproportionate for a
single-operator deployment with a fixed set of callers.

### Use fixed, capability-scoped credentials (chosen)

One administrative secret, one automation secret, and one optional ingestion
secret per external source provide the needed separation without introducing a
general authorization product.

## Decision

`API_ADMIN_KEY` authorizes every REST route and MCP tool.
`API_AUTOMATION_KEY` authorizes reads, ordinary collect/dedup/deliver work,
study-plan generation and MCP, but not external ingestion or permanent discard.
`INGEST_<SOURCE>_API_KEY` authorizes only
`POST /runs/collect/external` when the request body names that exact source.
Non-admin authorization is an explicit route allowlist, with trailing slashes
normalized and every unknown route denied by default.

Configured values must be distinct. All comparisons use fixed-size SHA-256
digests with `timingSafeEqual`. The authenticated request carries a non-secret
principal identifier composed from its role/source and a short digest; that
identifier scopes expensive-operation rate limits and is persisted as
`runs.triggeredBy`. The credential value is never persisted.

`API_KEY` remains only as a temporary fallback for `API_ADMIN_KEY` so an
existing deployment can migrate without a flag day. This decision supersedes
the single-credential portions of ADR-017, ADR-027 and ADR-030, and ADR-046's
shared-key assumption; their networking, collector-boundary and two-layer
rate-limit decisions remain, with the limit now partitioned by principal and
operation.

## Consequences

- Compromise of a collector credential is confined to ingestion for its own
  source; automation cannot ingest arbitrary data or discard postings.
- REST and MCP calls by the same principal share one expensive-operation
  budget, while unrelated principals no longer consume each other's budget.
- Adding a route requires an explicit decision about non-admin access. The
  safe default is a `403`, which can surface a missed allowlist update during
  deployment rather than silently widening access.
- Rotation remains coordinated and accepts only one current value per
  principal. Supporting overlapping keys or dynamic revocation would require a
  credential store or an external identity provider.
- The short digest is attribution, not a durable human identity: rotating a
  credential changes it. Reversing this decision means either returning to one
  shared blast radius or adopting a fuller identity system.
