# ADR-030 — A Cloudflare Tunnel route, Bearer-only, for the n8n.cloud caller

## Status

Accepted

## Date

2026-08-16

## Context

ADR-029 connects LinkedIn's job-alert emails through an n8n workflow POSTing
to `/runs/collect/external` — the same authenticated boundary ADR-027 built
for Indeed. That ADR left "connecting the n8n workflow itself" as the user's
own infrastructure, not repository work. Connecting it surfaced a fact ADR-017
did not have: **n8n runs on n8n.cloud, a SaaS instance with no shell access.**
It cannot install a Tailscale client and join Atlas's tailnet the way Hermes's
machine does — there is no host to install it on.

ADR-017 already considered and rejected a Cloudflare Tunnel for the API
boundary, for a reason that no longer fully holds: "it means public DNS and a
public edge in front of an API whose only intended caller is a single machine
already on the same private Tailscale network." n8n.cloud is a second caller,
and it is provably not reachable over Tailscale — the premise the rejection
rested on. ADR-017 named exactly this situation, in its own Consequences
section, as what would justify revisiting the network decision: "a
requirement to reach the API from a machine that cannot join the tailnet."

Atlas already runs `cloudflared` for `portfolio` and `admin` (task-manager)
via a locally-managed config at `/etc/cloudflared/config.yml`, routing by
hostname to `http://localhost:80` (Nginx). No new software, no new tunnel —
adding a hostname is a config-file change and a DNS record.

## Considered options

### Tailscale Funnel

Keeps a single network technology, but is a direct reversal of ADR-017's
stated reason for choosing Tailscale in the first place — "unreachable from
the public internet even if UFW is ever misconfigured" stops being true the
moment Funnel is enabled. Rejected: it would need its own ADR amendment
arguing against ADR-017's own words, for no benefit over the tunnel Atlas
already runs.

### Cloudflare Tunnel + Cloudflare Access (service token)

The full upgrade path ADR-017 names: Access gates the request before it ever
reaches `ApiKeyGuard`, matching `atlas-manager`'s own defense-in-depth
pattern. Deferred, not rejected — real setup cost (an Access application, a
service token, `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers
configured on the n8n side) for a caller sending low-stakes data (job
postings it already found) through the narrowest endpoint on this API
(`/runs/collect/external` normalizes and stores; it does not trigger a
Telegram send or spend on the LLM the way `/runs/deliver` does). Worth
revisiting if a third public caller arrives, or if this endpoint's blast
radius grows.

### Cloudflare Tunnel, Bearer key only (chosen)

New `cloudflared` ingress hostname, `argos-api.gustavopinto.dev.br`, routed
to `http://100.112.68.45:3000` — the same Tailscale-bound address Hermes
already reaches, just now also reachable through the tunnel running on the
same host. No change to `ApiKeyGuard`, no change to `compose.production.yaml`
(the port is still never bound to `0.0.0.0`; the tunnel is a new local
reacher of an address that was already listening, not a new public bind).
`API_KEY` — the same one Hermes uses — is the entire gate.

## Decision

Add one ingress rule to Atlas's existing `cloudflared` config, ahead of the
catch-all 404, and a matching DNS record:

```yaml
- hostname: argos-api.gustavopinto.dev.br
  service: http://100.112.68.45:3000
```

n8n's HTTP Request node calls `https://argos-api.gustavopinto.dev.br/runs/collect/external`
with `Authorization: Bearer <API_KEY>` — the identical header Hermes sends
over Tailscale. Hermes's own path is unchanged: it still reaches the API over
Tailscale directly, never through this hostname. Two paths into the same
`ApiKeyGuard`-gated app, chosen per caller by what that caller can actually
reach, not a replacement of one with the other.

**Correction, found applying this ADR.** The `config.yml` ingress rule above
was written on the assumption this tunnel is purely locally-managed, matching
how `gustavopinto.dev.br`/`admin.gustavopinto.dev.br` already worked. That
assumption was wrong: creating the hostname through the Cloudflare Zero Trust
dashboard ("Networks → Tunnels → Public Hostname") had, at some earlier
point, also registered a **dashboard-side route** for this tunnel — and that
route wins over the local file for any hostname defined in both places.
Confirmed from `cloudflared`'s own log line after a restart
(`journalctl -u cloudflared`), which showed the *effective* ingress config
routing `argos-api.gustavopinto.dev.br` to `http://localhost:80`, not the
`100.112.68.45:3000` the local file said — silently wrong until diagnosed by
comparing the log's actual applied config against the file on disk. The real
fix was editing the Service URL for that hostname in the dashboard directly,
to `http://100.112.68.45:3000`; the `config.yml` edit is harmless but inert
for this hostname now that a dashboard route exists for it. Left in the file
rather than removed — reversion cost stays low, and it correctly documents
intent even though the dashboard is what actually governs.

## Consequences

**Easy:** zero new infrastructure — reuses the `cloudflared` process, the
tunnel, and the `ApiKeyGuard` already running. A route to a `--rm`-style
disposable caller like n8n.cloud costs one YAML block and one DNS record.
Reversal is the same shape: delete the ingress rule and the DNS record,
restart `cloudflared`; nothing in application code references this hostname.

**Hard, stated plainly:** the entire API — not just `/runs/collect/external`
— becomes reachable from the public internet through this hostname, because
`ApiKeyGuard` is a single global guard with no per-route scoping and
`cloudflared` routes by hostname, not by path plus hostname here. Anyone who
obtains `API_KEY` can now reach every route (including `POST /runs/deliver`,
a real Telegram send and LLM spend) from anywhere, not only from the tailnet.
This is the same key Hermes uses — rotating it to scope n8n out means
rotating Hermes's access too, exactly the "revoking one caller revokes
everyone" cost ADR-017 already named as the shared-secret model's limit. That
cost is now reachable from the public internet, not only the tailnet, which
is strictly worse than before this ADR and is the real price of this choice.

**What would justify upgrading:** the Access service-token option above,
scoped to this hostname specifically — the moment this endpoint's blast
radius grows (e.g. if it is ever given its own side effects beyond storing
postings) or a third public caller needs distinguishing from n8n.

**Reversal cost:** low for the network path (see Easy). Not low for the
exposure itself while it exists — see Hard.
