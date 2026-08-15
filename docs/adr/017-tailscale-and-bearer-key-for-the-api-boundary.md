# ADR-017 — Tailscale networking and a fixed Bearer key for the HTTP/MCP boundary

## Status

Accepted

## Date

2026-08-15

## Context

M9 gives the process an HTTP surface for the first time — `main.ts` switched
from `createApplicationContext()` (M8, no listener) to
`NestFactory.create()` and `app.listen()`. Two questions had to be answered
before any endpoint could be written: how does a request reach the
container, and how does the container decide to trust it.

The consumer is Hermes Agent, confirmed this session (`CLAUDE.md` §10,
corrected in PR #26) to run on a **different machine** than Atlas — not a
same-box integration reachable over `localhost`, but a real network boundary.
Atlas already runs two other services reachable from outside itself:
`portfolio` and `task-manager`, both through a Cloudflare Tunnel
(`cloudflared`) fronting a container bound to `127.0.0.1:<port>`, with
Cloudflare Access handling authentication at the edge. Atlas is also already
joined to a personal Tailscale network (confirmed via `tailscale status`,
interface IP `100.112.68.45`), unused by any app so far.

`POST /runs/deliver` (M9 PR2) triggers a real scoring pass and a real
Telegram send on demand — the same consequence the nightly cron has, but
reachable outside the batch window. Whatever answers "how is a request
trusted" has to be good enough to gate that, not just read-only endpoints.

## Considered options

### Network: Cloudflare Tunnel, matching `portfolio`/`task-manager`

Consistent with the existing pattern, and gets Cloudflare Access for free if
adopted alongside it. Rejected for now: it means public DNS and a public edge
in front of an API whose only intended caller is a single machine already on
the same private Tailscale network. It solves "reachable from anywhere",
which is not the actual requirement — the actual requirement is "reachable
from the one other machine Hermes runs on."

### Network: port exposed over Tailscale, bound to the interface IP

Chosen. Atlas and Hermes's machine both join the same tailnet; the port is
published bound to Atlas's Tailscale interface IP
(`${ATLAS_TAILSCALE_IP}:${API_PORT}:${API_PORT}` in
`compose.production.yaml`, not `0.0.0.0`), so it is unreachable from the
public internet even if UFW is ever misconfigured — binding to the private
interface is a second, independent control, not the only one. No new public
DNS entry, no new edge service to operate. Cost: a second network pattern
alongside the Cloudflare Tunnel one, and Hermes's machine must itself be
tailnet-joined (true today; not verified from this session, since no second
tailnet machine was available to call in from — recorded honestly in
`docs/10-milestones.md` rather than assumed).

### Auth: Cloudflare Access + JWT/JWKS, matching `atlas-manager`

`atlas-manager` already proves this pattern works and is more capable
(per-identity access, no shared secret to rotate). Rejected for now, not
permanently: it is real infrastructure to stand up (an Access application,
JWKS verification wired into `ApiKeyGuard`'s replacement) for a boundary with
exactly one trusted consumer. Documented here as the upgrade path — see
Consequences.

### Auth: fixed Bearer API key

Chosen. A single secret (`API_KEY` in `.env`, generated with
`openssl rand -hex 32`), checked with `crypto.timingSafeEqual` after a
SHA-256 pre-hash so mismatched-length inputs never leak a length signal, and
applied globally via `APP_GUARD` (`ApiKeyGuard`) so a controller added later
is authenticated by default rather than by remembering `@UseGuards`. Simple,
auditable, sufficient for one trusted consumer holding one secret.

## Decision

The API and MCP surfaces are reached over Tailscale, bound to Atlas's
Tailscale interface IP at the compose level, never `0.0.0.0`. Every route —
REST and `/mcp` alike, MCP-over-HTTP is still HTTP — requires
`Authorization: Bearer <API_KEY>`, checked with a timing-safe comparison.
The process refuses to start without `API_KEY` set (`ApiKeyGuard`'s
constructor throws), per `docs/09-configuration.md` rule 1: a required secret
missing at startup is a boot failure, not a silently-unauthenticated route.

`POST /runs/deliver` is deliberately reachable through this same boundary —
real API spend and a real Telegram send, remotely triggerable. This is the
intended capability ("Hermes can ask for a check now"), not a footgun being
hidden: anyone who can present a valid `API_KEY` can trigger it, which is
exactly the set of people (one) who should be able to.

## Consequences

**Easy:** adding a route is automatically authenticated (global guard); no
new public attack surface (no DNS, no edge, private interface only);
rotating the key is a `.env` edit and a restart, no coordination with an
identity provider.

**Hard:** a second consumer, or a consumer not on the tailnet, cannot use this
boundary as built — a shared secret does not distinguish callers, and there
is no path in that does not require tailnet membership. Revoking access from
one caller without affecting others is not possible; the only lever is
rotating the key, which revokes everyone.

**What would justify upgrading:** a second trusted consumer needing distinct
access, or a requirement to reach the API from a machine that cannot join the
tailnet. At that point the Cloudflare Access + JWT/JWKS pattern
`atlas-manager` already proves is the documented next step, not a decision to
re-litigate — this ADR's job was to pick the right thing for one consumer on
one private network, not the final shape of the boundary.

**Reversal cost:** low. Nothing about the key-based `ApiKeyGuard` or the
Tailscale bind leaks into `RunsService`, `RunsController`, or
`McpController` — all three depend only on being inside an authenticated
request, not on how authentication happened. Swapping the guard's
implementation and the compose network stanza does not touch application
code.
