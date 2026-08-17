# ADR-049 — Bound, trace, and resume model work

## Status

Accepted

## Date

2026-08-17

## Context

ADR-036 bounded the posting description and sanitized logs, while ADR-037
proved that returned evidence existed in the profile. A later audit found
remaining gaps: titles and some model-produced fields were unbounded; response
bodies could stall or grow independently of the request timeout; cached Stage B
answers were not rechecked against current evidence rules; a genuine profile
quote could be attached to an unrelated requirement; and one failed requirement
discarded successful Stage B calls from the same posting.

Run-level accounting also could not distinguish cache hits, provider attempts
without usage data, or evidence silently coerced to `not_met`. Those omissions
made safety behavior difficult to audit and repeated paid work after a partial
failure.

## Considered options

### Trust provider schemas, prompts, and full-result caching

Rejected. Prompts are guidance, remote bodies and LLM output are untrusted, and
a cache hit must not bypass a safety invariant added after the row was written.

### Add an independent semantic verifier for every evidence quote

Deferred. A second model repeats the trust and cost problem; a complete
requirement-to-competency taxonomy does not exist. A conservative lexical guard
is useful now, provided it is documented as a filter rather than proof.

### Bound every boundary, expose degradation, and checkpoint valid answers (chosen)

This reduces blast radius and repeat cost while keeping uncertainty visible to
the operator.

## Decision

Model input and output have explicit ceilings: title 500 characters,
description 12,000, requirement text 500, category 100, and returned evidence
2,000. OpenRouter, Telegram, and Catho HTTP response bodies are read through
bounded, abort-aware readers so a request deadline covers headers and body
consumption. Invalid Unicode numeric entities degrade to the replacement
character instead of aborting a run.

Every Stage B evidence quote must both resolve exactly to the canonical profile
catalog and pass a conservative applicability check: the requirement must name
the competency, an alias, or the controlled vocabulary for a declared profile
field. A rejection is coerced to `not_met` and increments
`evidenceRejectedCount`. Full and partial cache rows are revalidated with the
same checks before reuse. This lexical test reduces accidental or injected
misattribution; it is not semantic proof because hostile text can repeat a
relevant token while requesting unrelated evidence.

Stage B checkpoints each validated requirement answer under the complete cache
identity: posting fingerprint, profile hash, prompt version, model,
requirements hash, and requirement index. A later run resumes missing answers;
the full cache is published only when every position is valid. One captured
`evaluatedAt` instant owns profile hashing, prompt evidence, provenance checks,
and cache timestamps for a scoring call.

Scoring persists Stage A/B cache-hit flags, truncation, rejected-evidence count,
transport outcomes, prompt/completion/cached token totals, provider cost,
circuit-breaker refusals, and attempts whose response contained no usable usage
data. The digest warns when the posting was truncated.

## Consequences

- Pathological inputs and responses have deterministic memory/time bounds, and
  reduced input or unverifiable evidence is visible rather than silent.
- Partial checkpoints avoid repeating successful paid calls after a later
  requirement fails, but add a table and cache invalidation surface.
- The applicability guard can reject legitimate evidence when a requirement
  uses an unknown synonym. Updating aliases or controlled vocabulary changes
  what old cache rows can be reused.
- A passing lexical check still does not prove semantic relevance. Decisions
  that require stronger assurance need a taxonomy or independently trusted
  verifier and a new ADR.
- Provider usage remains reported data, not billing truth. A nonzero
  `attemptsWithoutUsage` explicitly means locally summed cost is a floor.
