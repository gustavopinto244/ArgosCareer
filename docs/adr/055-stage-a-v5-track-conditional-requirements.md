# ADR-055 — Stage A v5: merge track-conditional requirement branches

## Status

Accepted

## Date

2026-08-22

## Context

`docs/11-known-issues.md` B9 traced a real scoring miss on the Smarthis
posting (hand score 100, computed `mandatoryCoverage` 40%) to a shape
`a-v4` had no instruction for: the posting states different requirements
for different tracks within one multi-track internship program —

> **Para vagas com foco em Desenvolvimento:** conhecimento em uma linguagem
> de programação... **Para vagas com foco em Processos e Projetos:**
> conhecimento em gestão de processos...

`a-v4` extracted both branches as independent, unconditional `mandatory`
requirements. A dev-track candidate who correctly evidenced the
Desenvolvimento branch was then also scored against the Processos e
Projetos branch — a requirement the posting never actually asked of them.
B9 flagged this as "worth an ADR when picked up" and explicitly deferred it
rather than bundling a prompt change into an unrelated session, per the M7
protocol's "change one variable at a time" rule
(`docs/04-scoring-model.md`).

## Considered options

### Teach Stage B to recognize the conditional phrasing instead

Rejected: by the time Stage B runs, the two branches are already two
separate `Requirement` objects — the conditional relationship between them
existed only in the posting's original text, which Stage B's prompt does
not see (it receives one requirement at a time, ADR-013's whole design).
Fixing it at Stage B would mean passing sibling-requirement context into
every match call, a materially bigger change than a wording-only prompt
edit.

### Add a new `Requirement` field (e.g. `appliesToTrack`) and skip non-applicable branches in Stage C

Rejected. Stage A has no reliable way to know the _candidate's_ track at
extraction time — extraction is cached per posting, independent of any one
profile (ADR-007) — so "skip the branch that doesn't apply" cannot be
decided during extraction without either breaking that cache (making
extraction profile-dependent) or guessing. It also touches the `Requirement`
schema, `score.ts`, and every place that reads `weight`/`verifiable` today —
a bigger, riskier change than the actual defect requires.

### Merge parallel branches into one alternative ("OR") requirement at Stage A (chosen)

The posting's text already states the branches as parallel alternatives for
different applicants to the same program — not sequential, not both
required. Recognizing that shape and combining it into a single requirement
whose text expresses both sides as an "OR" keeps the fix entirely inside
Stage A's existing output shape: same `Requirement` fields, no schema
change, and Stage B's existing "does the profile evidence this text"
matching can succeed against whichever side actually applies, without Stage
B needing to know anything about tracks at all.

## Decision

`prompts/stage-a-extraction.v5.md` adds one instruction: when a posting
splits requirements by track/focus (`"Para vagas com foco em X: ... Para
vagas com foco em Y: ..."`, `"para a área de X" / "para a área de Y"`, or a
visibly track-split bulleted list), combine the parallel branch-specific
statements into a single requirement stating them as alternatives, weighted
by the strictest branch. Requirements genuinely shared across every track
are left alone. Everything else — output shape, `verifiable` rules,
seniority/experience extraction, the untrusted-content framing `a-v4`
added — is unchanged. `STAGE_A_PROMPT_VERSION` becomes `a-v5`
(`src/scoring/infrastructure/prompts.ts`); `a-v4` stays on disk, unedited,
as ADR-007's cache-key precedent requires.

**Measured, one variable changed** (Stage B stayed `b-v4`, model, weights
and cutoffs untouched), against the full current 18-posting worksheet
(`data/calibration/labels.yaml`, `npm run calibration:run`):

|                              | `a-v4` (baseline)      | `a-v5`                 |
| ---------------------------- | ---------------------- | ---------------------- |
| Scored / n                   | 13/18                  | 18/18                  |
| Parse-failure rate           | 28%                    | 0%                     |
| Correlation                  | 0.357                  | 0.468                  |
| `apply` precision / recall   | 100% / 40% (support 5) | 100% / 25% (support 8) |
| `discard` precision / recall | 40% / 80% (support 5)  | 50% / 86% (support 7)  |
| Cost                         | $0.0305                | $0.0272                |

**The recall figures are not a clean comparison and this ADR does not
claim otherwise.** `a-v4`'s 28% parse-failure rate means 5 of 18 postings
were dropped from every metric entirely, including from each verdict's
support count — a smaller, silently non-random sample, not a stricter one.
`a-v5`'s 0% failure rate means its numbers cover all 18. The two
parse-failure rates are themselves very likely unrelated to this prompt
change — nearly every retried `invalidOutput` in both runs' logs is a
`stage-b:` failure (`Relace`, an OpenRouter provider, truncating output
mid-JSON), and Stage B's prompt did not change between these two runs. Not
claimed as a benefit of `a-v5`; recorded because the two runs' raw numbers
would otherwise look more different than they are.

**What this ADR does verify directly, not just via the aggregate table:**
pulled Smarthis's real `extractions` row for both prompt versions.
`a-v4` emits the two branches as separate `mandatory` requirements, exactly
as B9 described. `a-v5` emits one merged requirement: _"Conhecimento em
pelo menos uma linguagem de programação... (para vagas com foco em
Desenvolvimento) OU conhecimento em gestão de processos... (para vagas com
foco em Processos e Projetos)."_ The extraction-shape defect this ADR set
out to fix is confirmed fixed, on the actual posting that motivated it —
not inferred from the aggregate correlation, which at n=18 is too noisy to
carry that claim alone.

**What this ADR does not fix, checked and left alone on purpose:**
Smarthis's real Stage B match for the merged requirement still answers
`not_met`, despite `config/profile.yaml` evidencing Node.js — a
programming language, which should satisfy the "Desenvolvimento" side of
the OR. This is Stage B matching quality, the same ~0.4-correlation-ceiling
limitation already named in B9's `workAvailability` follow-up, not an
extraction problem, and fixing it would be a second variable — explicitly
out of scope for this ADR under the M7 protocol.

## Consequences

**What this makes easy:** any future posting with the same "Para vagas com
foco em X" shape — a real, recurring pattern in multi-track internship
programs, not unique to Smarthis — is extracted correctly without a
candidate being penalized for a branch that was never asked of them.

**What this does not solve:** Smarthis's own computed score is still far
from its hand label, because the residual gap is now entirely a Stage B
matching-quality question, unrelated to this fix. B9 stays partially open
for that reason — this ADR closes the specific defect it targeted, not the
whole entry.

**Cache cost of adopting this:** bumping `STAGE_A_PROMPT_VERSION` means
every posting's cached Stage A extraction is invalidated (ADR-007's
`(fingerprint, promptVersion, contentHash)` key) — the next `deliver` cycle
re-extracts from scratch. At today's real admission rate (A1/A3's
2026-08-22 measurement: single-digit postings per cycle), this costs
cents, not the near-$1 it would have at the corpus's 2026-08-16 volume.

**Reversal cost:** low. Revert `STAGE_A_PROMPT_VERSION`/`STAGE_A_PROMPT_PATH`
to `a-v4`; the file itself is untouched and still on disk.
