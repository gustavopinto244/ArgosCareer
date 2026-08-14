# ADR-008 — Use n8n as a pluggable collector adapter and outbound consumer, never as the orchestrator

## Status

Accepted

## Date

2026-08-14

## Context

n8n is a low-code automation platform, and there is a deliberate wish to include
it in this project: integration work with it is worth demonstrating.

That is a legitimate reason, and it is also exactly the kind of reason that
produces bad architecture if left unexamined. The project already faced the same
shape of question with Hermes Agent and answered it: **do not let a third-party
tool become the core**, because what remains is configuration of someone else's
product with no reviewable code of one's own.

Two independent needs make n8n genuinely useful here rather than decorative:

1. The expanded vision names LinkedIn, Gupy, Indeed "and other relevant
   platforms identified during development". A long tail of sources, each worth
   little individually, each currently requiring a TypeScript adapter, a schema,
   fixtures and tests.
2. Once the M9 API exists, useful side effects appear that have nothing to do
   with the pipeline — logging an application to a spreadsheet, creating a
   deadline reminder, cross-posting a digest.

There is a hard constraint. Atlas has ~6.1 GB free and ArgosCareer's budget is
~150 MB at rest. **n8n's memory footprint is unmeasured**; an idle instance is
commonly reported in the low hundreds of megabytes, which would exceed the
entire application budget on its own. Treated here as an assumption to measure,
not a number to plan against.

## Considered options

### n8n orchestrates the pipeline

Rejected. It is the fastest path and it destroys the project. Collection,
dedup, filtering and scheduling would become node configuration; the reviewable
artifact would be an exported workflow JSON. This is the Hermes decision
(`02-architecture.md`) applied to a different vendor, and the answer does not
change because the vendor does.

It also puts a container on the critical path of the Tuesday and Friday digest.

### n8n replaces `@nestjs/schedule`

Rejected. It trades a library already in the stack for a network dependency and
a running container, buying a cron expression. The digest would stop arriving
whenever n8n was down.

### n8n performs scoring or normalization

Rejected. These are the parts with actual domain logic, unit tests, and a
calibration protocol. Moving them into a workflow makes them untestable in CI and
unmeasurable in M7.

### n8n behind `CollectorPort`, plus an API consumer

Accepted. Both placements keep the core unchanged and independently valuable.

## Decision

**Inbound — `N8nCollector` implements `CollectorPort`.**

An n8n workflow handles one long-tail source and exposes an HTTP webhook
returning JSON in the `RawPosting` envelope. `N8nCollector` calls that webhook
and is, from the pipeline's perspective, an ordinary collector: it validates
tolerantly with Zod, and it never throws — an unreachable or misbehaving n8n
produces a `CollectionResult` with `error` set and an empty list, exactly like a
broken Gupy.

This is principle 3 applied to sources: adding a long-tail source becomes
configuration and a workflow, not an application change. Gupy stays a
first-class TypeScript adapter — it is P0, and its schema deserves real tests.

**Outbound — n8n consumes the M9 HTTP API.**

For side effects that are not the product: spreadsheets, reminders, cross-posts.
n8n polls or receives a webhook; ArgosCareer neither knows nor cares.

**Boundary rules, non-negotiable:**

1. n8n is **never on the critical path.** The Tuesday and Friday digest goes out
   through the direct Telegram client with n8n stopped. This is the same test
   applied to Hermes, and it is a test, not a slogan — M9 verifies it.
2. **No domain logic in a workflow.** A workflow fetches and reshapes. Scoring,
   dedup, filtering and normalization stay in code.
3. **Webhook payloads are untrusted input**, validated like any external
   response.
4. The webhook is **authenticated** and not exposed publicly.

## Consequences

- Long-tail sources become cheap. A source not worth a TypeScript adapter, a
  fixture and a test suite becomes worth adding.
- The demonstration is honest and specific: a low-code platform integrated as a
  pluggable adapter behind a port, with the core provably indifferent to its
  availability. That is a better claim than "used n8n", and the boundary is the
  interesting part.
- **A source behind n8n is less well tested than a native adapter.** Its
  reshaping logic lives outside the repository, outside CI, and outside version
  control unless workflows are exported and committed. This is the real cost, and
  it is why P0 Gupy is not moved there.
- **Workflows must be exported and committed** to `n8n/` for the source to be
  reproducible. A workflow that exists only in a running instance is undocumented
  infrastructure.
- **Another container, and unmeasured memory.** If n8n's footprint proves
  incompatible with what Atlas has free alongside `atlas-manager`, Nginx,
  cloudflared and the other containers, the inbound half is dropped and the
  outbound half — which can run anywhere — survives. Measured in M8.
- One more failure mode to observe: an n8n-backed source silently returning
  nothing is covered by the consecutive-empty-source alert in
  `08-observability.md`, at no extra cost.
- Reversing the inbound half is cheap: a long-tail source can be promoted to a
  native adapter at any time, since it already sits behind `CollectorPort`.
