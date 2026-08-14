# ADR-003 — Write the repository in English, deliver the digest in pt-BR

## Status

Accepted

## Date

2026-08-14

## Context

The project is written by a Brazilian developer, about Brazilian job postings,
for a single Brazilian reader. Portuguese would be the natural default, and the
initial project brief specified it.

Two facts push the other way. The repository is public and exists to be read by
recruiters and engineers evaluating the work, an audience that is not reliably
Portuguese-speaking. And `atlas-manager`, the sibling repository, is already
fully English — documentation, ADR filenames, module names such as
`access-control` and `backup-management`.

There is also a technical consideration: small models handle English
instructions more reliably than Portuguese ones, and the production scorer target
is a 4B model.

These pressures do not all point at the same artifacts. Source code is read by
the public audience; the Telegram digest is read by exactly one person.

## Considered options

### Everything in Portuguese

Rejected. It would fragment conventions across two repositories by the same
author and narrow the audience of a portfolio artifact whose purpose is to be
read.

### Everything in English, including the digest

Rejected. The digest quotes posting titles, company names and requirement text
that are Portuguese in the source. Rendering the surrounding text in English
produces a bilingual message that is harder to skim than either language alone —
and skimming speed is the primary goal of the project.

### English repository, pt-BR digest

Accepted. The split falls on a real boundary: durable artifacts that the public
reads are English; runtime output that one person reads, about Portuguese-
language source material, is Portuguese.

## Decision

**English:** source code and identifiers (`CollectorPort`, `ScorerPort`,
`CollectionResult`, `config/profile.yaml`), documentation, ADRs, commit messages,
pull request descriptions, code comments, and LLM prompts.

**pt-BR:** the Telegram digest.

Domain vocabulary that has no clean English equivalent stays Portuguese where it
refers to a Brazilian artifact — `estágio` and `estagiário` in pre-filter title
rules, because those are the literal strings being matched in posting titles.

## Consequences

- One convention across both repositories; a reader of either finds the same
  patterns.
- LLM prompts in English against Portuguese posting text. This is a normal
  configuration and generally the stronger one for small models, but it is an
  assumption to verify during M7 calibration rather than assert — prompt language
  is one of the variables the calibration can vary.
- Anything user-facing needs a conscious language decision at the boundary. The
  boundary is the `NotifierPort` adapter: everything inside it is English,
  everything it emits is Portuguese.
- The digest's section headings and verdict labels are translated at that
  boundary, so the verdict enum stays `apply | review | discard` in code while
  displaying as `candidatar | avaliar | descartar`. Two names for one concept is
  a small ongoing cost, accepted because the alternative is a mixed-language
  message.
- This supersedes the Portuguese-language instruction in the original project
  brief.
