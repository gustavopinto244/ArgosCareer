# ADR-050 — Bound hot-path work and batch persistence

## Status

Accepted

## Date

2026-08-17

## Context

The current corpus is small, but three hot paths had avoidable growth costs.
Stage B synchronously reread its prompt file and rebuilt identical profile
evidence for every requirement. Layer-2 similarity dedup compared a posting
with every earlier posting in a company's time window, which is quadratic for a
large employer group. Collection upserts and delivery notification marks each
opened their own transaction or update.

There is no production benchmark showing these are current bottlenecks. The
goal is to remove structurally repeated work and impose a safe upper bound
without changing user-visible filtering semantics.

## Considered options

### Wait for production latency to become visible

Rejected for the deterministic repetition and unbounded comparison loop: both
have small, testable fixes now. We still avoid claiming an unmeasured speedup.

### Replace dedup with a new index or approximate-nearest-neighbor service

Deferred. That adds operational complexity and calibration work. Layer 2 is
currently shadow-only, so a bounded diagnostic scan has a much lower cost.

### Cache invariant prompt work, bound shadow comparisons, and batch writes (chosen)

These changes retain existing identities and row semantics while removing
per-item overhead.

## Decision

Prompt templates are cached by resolved absolute path. One Stage B matcher call
builds its template and profile-evidence prefix once, then substitutes only the
requirement-specific fields.

Similarity dedup maintains a moving start for the configured time window and
compares each posting with at most the 500 newest eligible postings by default.
The bound affects only layer-2 shadow candidates; it never suppresses a posting.
`comparisonTruncatedCount` is returned, persisted and logged whenever a company
group exceeds the bound.

Repository batch methods preserve the existing per-posting upsert rules inside
one transaction and mark all successfully delivered fingerprints in one
update. Empty batches are explicit no-ops.

## Consequences

- Stage B no longer repeats synchronous disk reads or invariant evidence
  rendering for every model call in a posting.
- Dedup work is bounded by `O(n * maxComparisonsPerPosting)` after grouping and
  sorting. An old valid shadow duplicate outside the newest slice can be
  missed; the visible truncation counter exposes that loss of diagnostic
  coverage.
- Batch transactions reduce transaction lifecycle overhead but enlarge the
  rollback unit: an error in one collection batch rolls back that whole batch.
- Cached prompt files are immutable for the life of a process. Editing a prompt
  in place requires a restart, which is already required for deployed code and
  prompt-version changes.
- These are structural improvements, not a measured production performance
  claim. Benchmarking remains necessary before attributing a latency reduction
  to them.
