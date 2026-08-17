# ADR-029 — LinkedIn via the user's own job-alert emails, extracted by n8n

## Status

Accepted. Receiving side (schema, normalizer, registry entry, ingest
endpoint reuse) implemented and tested. The n8n workflow itself — parsing
the alert emails and POSTing to this boundary — is the user's own
infrastructure, connected separately from this repository.

## Date

2026-08-16

## Context

LinkedIn is CLAUDE.md §6's P2 source, "public visitor endpoints only." That
plan turned out to be worse than Indeed's ADR-028 situation, not
equivalent to it: LinkedIn's visitor-facing job search returns a Cloudflare
challenge like Indeed's, but unlike Indeed there is no `jobspy`-equivalent
that gets past it without also forging identity — and LinkedIn's own terms
carry an explicit anti-scraping notice, not merely a restrictive
`robots.txt`. Investigating this live surfaced a worse version of exactly
the tension ADR-028 named for Indeed, with none of ADR-028's mitigating
facts (jobspy's forgery is at least confined to headers Indeed itself never
inspects meaningfully; here the target site both inspects and prohibits).

CLAUDE.md §3 is unconditional regardless of any of that: never authenticate
a collector with a personal LinkedIn session or cookies. That rule was never
in question here — no code in this ADR touches LinkedIn's site at all.

The user proposed a different source entirely: LinkedIn's own opt-in
job-alert emails, already arriving in their inbox, parsed by an n8n workflow
they control (the same n8n already named in CLAUDE.md §6 for the P3 long
tail, ADR-008). This is not scraping LinkedIn — it is reading email the user
receives because they subscribed to it, the same category of access as
checking your own inbox in a browser. No LinkedIn endpoint is queried, no
LinkedIn session is created or reused, and §3 does not apply because there
is no LinkedIn collector.

The real cost, confirmed against a screenshot of the user's actual n8n
extraction table: the alert email states no job description, only
title, company and a combined location/work-mode string. Everything this
ADR's normalizer does is shaped by that one constraint.

## Considered options

### A dedicated LinkedIn scraper (visitor endpoints, best-effort UA)

Rejected outright. Worse than the Indeed case ADR-028 accepted, not merely
similar to it — see Context. Never built, never probed live; the anti-scraping
notice alone was enough to stop before writing a network call, per CLAUDE.md
§15's discipline in reverse: a fact worth not manufacturing evidence against
is still a fact worth trusting on its face when a provider states it plainly.

### n8n workflow fetches full posting pages by URL after extracting the link

Considered: the alert email's link (`/jobs/view/<id>/`) points at a real
LinkedIn page with a full description. Rejected for now — fetching that page
is a LinkedIn HTTP request either way, reintroducing the same question this
ADR exists to avoid, just moved one hop later and inside n8n instead of this
repository. Not ruled out permanently; if pursued, it is a decision for
n8n's own workflow design and a future ADR, not a change to this receiving
side.

### Reuse `/runs/collect/external`, treat description as permanently absent (chosen)

No new ingest endpoint. LinkedIn becomes a second caller of exactly the
boundary ADR-027 built for Indeed: `POST /runs/collect/external`,
`ApiKeyGuard`-authenticated, `{ source: "linkedin", postings: [...] }`. A
new schema and normalizer are the entire diff — `linkedin-alert-schema.ts`,
`linkedin-alert-normalizer.ts`, one registry line.

## Decision

**`LinkedinAlertJobSchema`** (`linkedin-alert-schema.ts`): `.passthrough()`,
requires only `title` and `company`; `location` and `link` optional and
nullable. Fitted to the real n8n extraction table the user shared, which
also carried `Subject`/`ReceivedAt`/`ExtractedAt` columns this schema does
not require, since the normalizer never reads them.

**`normalizeLinkedinAlertJob`** (`linkedin-alert-normalizer.ts`), the one
piece of real logic this ADR adds:

- **`location` arrives as one bundled string** —
  `"Cidade, UF (Modo)"` or `"Brasil (Modo)"` — unlike every other source's
  separate fields. `parseLocationAndWorkMode` splits it: the parenthetical
  maps to `WorkMode` (`remoto` → `remote`, `híbrido`/`hibrido` → `hybrid`,
  `presencial` → `onsite`, anything else → `unknown`); the text before it
  becomes a known city (first comma segment) unless it is the literal
  country name `"Brasil"`, which maps to `location: unknown` rather than a
  fabricated city.
- **Splitting them is the entire point.** Once separated, the existing
  pre-filter's asymmetric location leniency (`isLocationAllowed`, ADR-011
  Amendment 3 — reject only when work mode is known-non-remote AND location
  is known-and-disallowed) already does exactly what the user asked for
  ("separar o local do modelo, e filtrar os híbridos em outros lugares")
  with zero new pre-filter code.
- **`publishedAt` is always `null`.** The alert states when LinkedIn sent
  the email, not when the posting went up — treating one as the other is
  exactly the invented fact CLAUDE.md §15 forbids. This is CIEE's situation
  again (`docs/11-known-issues.md` B1): `firstSeenAt`, set by the caller at
  ingest time, is what ADR-011 Amendment 4's `maxAgeDays` falls back to.
- **`description` is always `null`.** The alert email states no description
  at all — not a parsing gap, a fact about the source. Stage A already
  treats a null description as nothing to extract, at zero LLM cost
  (`stage-a-extractor.ts`); the resulting empty requirement list trips
  `lowConfidence` (`docs/04-scoring-model.md`), capping the verdict at
  `review` and never `apply`. No new scoring code — the existing safety net,
  built for a different trigger, applies here unchanged.

**Registered as `"linkedin"`** in `normalizer-registry.ts`, alongside
`gupy`/`ciee`/`indeed`.

**A rendering gap this ADR's own `lowConfidence` reliance exposed and
fixes:** `renderPostingEntry` (`render-digest.ts`) never surfaced
`ScoreOutcome.lowConfidence`, even though `ScoreOutcome` has carried the
field since M7. Because empty-category coverage is defined as `1`
(docs/04), a LinkedIn posting's `mandatoryCoverage`/`desirableCoverage` are
both `1` from having nothing to fail, which — combined with a matching
track's `trackAlignment` weight — can reach a 100% score. Displaying that
percentage without the `lowConfidence` flag reads as a strong match instead
of an unverified one. Fixed by adding a warning line
(`⚠ Confiança baixa — poucos requisitos verificáveis extraídos da vaga`)
whenever `lowConfidence` is true, for any source, not only LinkedIn.

## Consequences

**Easy:** zero new infrastructure — same auth boundary (ADR-017), same
`RunLock` kind (ADR-024), same normalize-returns-null-not-throw contract
(principle 1), same testable-core pattern as Indeed's ingest
(`executeIngestExternal`). Reversal cost is the same as ADR-027's: delete
the schema, the normalizer, the registry line.

**A real, permanent limitation, not a bug to fix later:** LinkedIn postings
through this path never reach `apply` on their own, by design — no
description means no verified match, ever, only `review` at best. That is
the correct, honest behavior given what the source actually provides, not a
gap to close; closing it would mean fetching the full posting page, which
is the scraping question this ADR exists to avoid (see the rejected middle
option above).

**A real gap left open:** which LinkedIn alert searches to actually
subscribe to, and connecting the n8n workflow to this endpoint, are the
user's own infrastructure and are not tracked as repository work — this ADR
covers the receiving side only.

**Coupled to §6's amendment history:** this is the second source (after
Indeed, ADR-027/028) to prove the same shape works — external collection
process, host-side or third-party, reporting in through the authenticated
API rather than living inside `argos-career`'s own container. If a third
source needs this, the shared shape is worth naming as a pattern rather
than re-deriving per ADR.
