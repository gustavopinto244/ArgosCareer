# ADR-001 — Use NestJS as the application framework

## Status

Accepted

## Date

2026-08-14

## Context

ArgosCareer is a headless batch service: a scheduler drives a pipeline of
collection, normalization, deduplication, filtering, scoring and delivery. Two of
the four architecture principles are structural — every stage independently
re-runnable, and the LLM engine a replaceable detail — and both depend on stages
talking to each other through ports rather than through concrete classes.

There will be at least three collector adapters, three scorer adapters and one
notifier adapter, and the scorer adapters exist specifically so that
`StubScorer`, `ApiScorer` and `OllamaScorer` can be swapped by configuration
during calibration.

A secondary goal is portfolio value. `atlas-manager` already demonstrates a
hand-wired ports-and-adapters composition over plain Express; repeating the same
approach here demonstrates nothing new.

## Considered options

### Plain Express with hand-wired composition

Rejected. It is what `atlas-manager` already does. It works, but every port
substitution becomes manual wiring in a composition root that grows with each
adapter, and the discipline holding the architecture together is convention
rather than anything enforced.

### Next.js

Rejected. It is a UI framework, and v1 is a headless batch service with Telegram
as its interface. Adopting it would mean carrying a rendering stack, a routing
model and a build pipeline for a program whose output is a chat message. Worth
reconsidering in Phase 3 if a dashboard is actually built — as a separate
decision, on its own merits.

### NestJS

Accepted. Its DI container makes a port an injection token and an adapter a
provider, so swapping implementations is a module change rather than an edit to
call sites. The layered module structure pushes toward ports-and-adapters by
default instead of by discipline, and `@nestjs/schedule` covers scheduling
without another dependency.

The cost is a framework with real surface area to learn, and a heavier runtime
than Express on a memory-constrained server.

## Decision

NestJS is the application framework. Modules follow the layering already used in
`atlas-manager`: `domain/` (entities and ports, no framework imports),
`application/` (use cases), `infrastructure/` (adapters), `composition/` (wiring).

The domain layer stays framework-free. That is what keeps stage C of the scoring
model a pure function that can be tested without booting an application context,
and it is the boundary that would survive replacing Nest later.

## Consequences

- Port substitution becomes configuration, which is what makes the
  `StubScorer` → `ApiScorer` → `OllamaScorer` progression cheap.
- Decorator metadata is now load-bearing: DI resolves constructor parameter types
  from `emitDecoratorMetadata`. This constrains the TypeScript configuration —
  see ADR-002.
- Higher baseline memory than plain Express, against a ~150 MB at-rest budget on
  Atlas. Measured in M8; if the budget is missed, this ADR is what gets revisited.
- A learning curve on a framework I have not used before. Accepted deliberately:
  the project has no deadline, and the secondary goal is served by learning
  something `atlas-manager` did not already prove.
- Reversing this is expensive once modules exist — roughly a rewrite of the
  composition layer, though the framework-free domain layer would survive intact.
