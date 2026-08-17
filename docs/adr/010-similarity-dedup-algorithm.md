# ADR-010 — Character-bigram Dice similarity for layer 2 dedup, threshold 0.35

## Status

Accepted — amended 2026-08-16 and 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-16-locations-must-not-contradict),
[Amendment 2](#amendment-2--2026-08-17-no-signal-must-never-score-as-a-match)
and
[Amendment 3](#amendment-3--2026-08-17-shadow-mode-layer-2-stops-merging-destructively)

## Date

2026-08-14

## Context

Layer 1 dedup (the fingerprint, ADR-007's `postings.fingerprint` unique
index) catches an exact re-collection of the same posting. It cannot catch
the case `docs/02-architecture.md` names as the reason layer 2 exists at all:
"Estágio em Back-end" and "Estagiário Backend (Rio de Janeiro)" from the same
company are the same job, but fingerprint punctuation-stripping (without
inserting a space, by design — see `fingerprint.test.ts`) and simple wording
differences give them different fingerprints.

Layer 2 needs an algorithm and a threshold. Neither was specified beyond "textual
similarity" and "same company, same time window."

## Considered options

### Word-set Jaccard similarity

Tried first, and measured before being rejected — not guessed. Tokenize the
normalized title, compare as sets:

```
Jaccard(A, B) = |tokens(A) ∩ tokens(B)| / |tokens(A) ∪ tokens(B)|
```

Rejected on evidence. Computed against the exact pair this project's own docs
cite as the motivating example:

```
"Estágio em Back-end" vs "Estagiário Backend (Rio de Janeiro)" → 0.14
```

The algorithm this ADR exists to choose failed to catch the case it was
chosen to solve. The cause: "estágio" and "estagiário" are different tokens
despite being the same word with a different ending, and word-level
comparison gives that difference full weight.

### Character-bigram Dice, no preprocessing beyond fingerprint's normalize

Also measured, also rejected. Character bigrams recover partial credit for
"estágio"/"estagiário" — the pair above scored 0.57 — but without removing
common words first, "Estágio Backend" vs "Estágio Frontend" scored **0.62**,
higher than the genuine duplicate pair. The shared boilerplate word
"Estágio" — present in nearly every posting this project collects, since the
pre-filter requires it in the title — dominated the score regardless of the
part that actually distinguishes two different roles.

### Character-bigram Dice over stopword-stripped, sorted significant tokens

Accepted. Strip a small, deliberately narrow list of words that carry no
discriminating signal for this specific corpus (`estágio`, `estagiário`,
`trainee`, `pessoa`, `vaga`, and a handful of Portuguese prepositions/articles
— `src/posting/domain/title-similarity.ts`), sort what remains so word order
does not matter, then compute the Sørensen–Dice coefficient over character
bigrams of the joined result:

```
significant(title) = sort(tokens(title) − STOPWORDS).join(" ")
Dice(A, B) = 2 × |bigrams(A) ∩ bigrams(B)| / (|bigrams(A)| + |bigrams(B)|)
```

Measured against the same cases, via `npx tsx`, not by hand:

| Pair                                                                             | Score |
| -------------------------------------------------------------------------------- | ----- |
| "Estágio em Back-end" / "Estagiário Backend (Rio de Janeiro)" — the docs example | 0.40  |
| "Estágio Back-End" / "Estágio Back End (Rio de Janeiro)" — hyphen vs. space      | 0.54  |
| "Estágio Backend" / "Estágio Frontend" — different roles, same boilerplate       | 0.31  |
| "Estágio Backend" / "Vendedor de Loja" — unrelated                               | 0.22  |

A workable margin opened between the highest score that must **not** match
(0.31) and the lowest score that must (0.40).

## Decision

`computeTitleSimilarity` (`src/posting/domain/title-similarity.ts`): stopword-
stripped, sorted, character-bigram Dice coefficient, as measured above.

**Threshold: 0.35.** Sits in the measured margin between 0.31 and 0.40.
Provisional, like every other weight and cutoff in this project until
measured against real data (`docs/04-scoring-model.md` carries the same
caveat for the scoring formula) — this one has no calibration protocol of its
own yet, unlike scoring's M7 process, so it is a judgment call informed by
the cases above, not a result.

**Scope, both load-bearing:**

- **Same company only.** `dedupSimilarPostings` groups by normalized company
  before comparing titles at all — two different companies never get
  compared, regardless of title similarity.
- **14-day window**, compared by `firstSeenAt`. A title match outside the
  window is not considered — a company reposting a similarly-named but
  distinct role eight months later should not collapse into one row.

**Canonical selection:** within a company group, postings are processed
oldest-`firstSeenAt`-first; each is compared only against postings already
kept as canonical in that pass, never against another duplicate. Earliest-
seen wins, deterministically, regardless of the order rows come back from the
database.

**Never deletes.** A match calls `PostingsRepository.markDuplicate`, setting
`duplicateOfFingerprint` — the row stays queryable
(`docs/05-domain-model.md`, "the corpus is not a cache").

**Independently re-runnable** (principle 2): `dedupSimilarPostings` reads and
writes only `PostingsRepository`, never a collector. Re-running it after
tuning the threshold or the stopword list touches nothing upstream — the
actual CLI-level test M4 asks for.

## Consequences

- The motivating example from `docs/02-architecture.md` is now a passing
  regression test (`title-similarity.test.ts`), not just a claim in prose.
- The stopword list is a hand-picked, Portuguese, internship-domain-specific
  list. It will miss whatever it does not anticipate — a new common word Gupy
  postings start using, or an English-language posting title. Extending it is
  a one-line change with no migration, since it only affects the dedup
  scan, never a stored fingerprint.
- **The threshold has no calibration protocol**, unlike the scoring model's
  M7 process. If M10's market analysis reveals systematic over- or
  under-merging, revisit the threshold with real measured false-positive and
  false-negative rates — this ADR's table is a starting point, not a result.

  A concrete one turned up immediately running the M4 CLI against live data:
  "Pessoa Estagiária | Tributário Contencioso" and "Pessoa Estagiária |
  Contencioso Cível Estratégico", two postings from the same law firm,
  scored 0.49 and were merged — but read as prose, these look like two
  genuinely different open roles (tax litigation vs. civil litigation), not
  the same job twice. The long shared word "contencioso" (11 characters, ~10
  bigrams) contributes far more to the score than the shorter words that
  actually distinguish the two roles ("tributário" vs. "cível estratégico").
  Character-bigram similarity structurally favors long shared substrings over
  short distinguishing ones — worth weighing against IDF-style down-weighting
  of common long words, or a length-normalized measure, if this pattern
  repeats once there is more than one example to generalize from.

- Character-bigram Dice is O(title length) per comparison and the grouping is
  O(n) per company — irrelevant at this project's volume, and would need
  reconsidering only if the corpus grew by orders of magnitude.
- Reversing the algorithm choice is cheap: `dedupSimilarPostings` depends only
  on `computeTitleSimilarity`'s signature (two strings in, a number out), so
  swapping the implementation later does not touch the repository or the CLI.

---

## Amendment 1 — 2026-08-16: locations must not contradict

Layer 2 grouped by company and compared titles within a time window. It never
looked at the city. A company hiring the same role in two cities is hiring
twice, and flagging one of them discards a real opening.

Measured on the real corpus once a second source made it visible:

|                                     |         |
| ----------------------------------- | ------- |
| postings flagged as duplicates      | 406     |
| **flagged across different cities** | **267** |
| of those, in the Rio metro region   | 17      |

The examples are unambiguous — MICHELIN's "Consultor de Desenvolvimento" in
São Paulo flagged against Belo Horizonte, Sicredi's "Gerente de
Desenvolvimento" in Sarandi against Toledo. The one that settles it is a
**"Pessoa Desenvolvedora Backend Python" in Rio de Janeiro**, discarded
against a canonical posting that stated no city at all: exactly the kind of
posting this project exists to find.

This was never a CIEE bug. It had been eating Gupy postings since M4 and only
became visible when the corpus grew fivefold.

**Decision:** a merge additionally requires the two locations not to
contradict. Both known and equal merges. Both unknown merges — nothing
contradicts. **Exactly one known does not**, because that is the shape that
ate the Backend Python posting: unknown is not agreement.

The asymmetry is deliberate and matches the direction of harm. Merging is
destructive — the loser drops out of every later stage — while declining to
merge only leaves a possible duplicate in the corpus, which layer 1 still
catches whenever the fingerprints truly match.

**Repairing the data, not just the rule.** Fixing the comparison does not
un-flag what the old rule got wrong, so `argos dedup --reset` clears existing
flags and lets a corrected pass re-decide. That is safe precisely because
`markDuplicate` only ever _sets_ a column — nothing was deleted when a
posting was flagged, so clearing it restores the posting whole. It is the
concrete payoff of "the corpus is not a cache" (`05-domain-model.md`): a
dedup bug is a re-run, never a re-collection.

Measured after the repair: 406 flags → **131**, 275 postings recovered,
pre-filter passes 291 → **310**, and **zero** remaining duplicates flagged
across different cities.

## Amendment 2 — 2026-08-17: no signal must never score as a match

A repository audit (`docs/audit/AUDIT_REPORT.md` AC-011, HIGH) found a
second real false positive, distinct from Amendment 1's location bug:
`computeTitleSimilarity("Estágio", "Trainee")` scored **1** — a perfect
match — because both titles are themselves entries in `STOPWORDS` and
strip down to the empty string. The function's zero-division guard
(`bigramsA.length + bigramsB.length === 0`) returned 1 for that case,
treating "there is nothing left to compare" as "confirmed identical," the
opposite of what it actually means.

**Decision:** that guard now returns 0, not 1. Two titles with no
discriminating signal left are never merged — 0 sits below every
threshold this project has used or considered — rather than defaulting to
the most destructive possible outcome. This does not touch the other
adversarial case this ADR's own Consequences section already documents
(the "Contencioso Cível" pair, 0.49, correctly non-empty on both sides but
still a real false positive from bigram similarity structurally favoring
long shared substrings) — that one remains open, explicitly deferred
there until a second example exists to generalize from, and this
amendment does not change that judgment.

**Consequence:** a company that reposts a role using only boilerplate
words in a shortened title (`"Estágio"` alone, no team/track name) no
longer risks being silently merged with an unrelated posting that
happens to share the same fate. The cost is symmetrical with Amendment
1's: layer 2 now declines to merge in one more case than before, which
only ever means a possible duplicate stays visible for layer 1 (exact
fingerprint) to catch if it truly is one — never the reverse.

**Reversal cost:** trivial — one literal (`return 0` back to `return 1`)
in `computeTitleSimilarity`, no schema or stored-data implications, same
as the rest of this ADR's reasoning about why tuning this function is
cheap.

## Amendment 3 — 2026-08-17: shadow mode — layer 2 stops merging destructively

Amendments 1 and 2 each fixed one measured false positive after it had
already cost a real posting — a different city silently accepted as
agreement, then two boilerplate-only titles silently accepted as identical.
Both times the fix was the same shape: find the specific wrong case, patch
the rule, `argos dedup --reset` to repair what the old rule had already
destroyed. A post-remediation audit (`docs/audit`, PR-006) asked the
question this project's own Consequences section had already raised and
left open: how many more cases like these exist that have not been found
yet, given the threshold "has no calibration protocol... this ADR's table
is a starting point, not a result"?

The audit found more, at the current threshold, without needing new data —
just the corpus already on Atlas: "Direito Trabalhista" vs. "Direito
Tributário" scored 0.57, "Engenharia Civil" vs. "Engenharia de Software"
scored 0.55. Both pairs read, in prose, as two distinct roles at the same
company — exactly the shape of the "Contencioso Cível" false positive this
ADR's Consequences section already flagged and deferred in 2026-08-14,
except these were not deferred: under the old destructive behavior they
were merged, and one of the two postings was gone.

**The pattern across all three amendments is the actual finding.** Every
fix so far has been reactive — a wrong merge is caught only when someone
happens to notice a specific posting missing, or happens to compute
`computeTitleSimilarity` against the live corpus by hand. There is no
system currently converting "layer 2 flagged this pair" into "a human
confirmed this pair is really one job" or "a human confirmed it is not."
Without that feedback loop, the threshold cannot be calibrated the way
`docs/04-scoring-model.md`'s M7 process calibrates scoring — there is
nothing to calibrate _against_.

### Decision

Layer 2 stops calling `markDuplicate`. A match is still computed, at the
same threshold, with the same company-grouping, window, and location-
agreement rules Amendments 1 and 2 already established — none of that
logic changes. What changes is what happens with the result: instead of
excluding the "loser" from `findActive()` and every stage after it, the
match is recorded as a `ShadowDuplicateCandidate`
(`src/persistence/application/dedup-similar-postings.ts`) and logged to
`posting_events` (`executeDedup`/`executeDedupAndClaim`,
`src/cli/main.ts`) with `stage: "dedup-similarity"`,
`outcome: "shadow_candidate"`, and a `reason` carrying the similarity
score and both titles. Both postings stay fully active — scored,
scoreable, deliverable, independently. Nothing is excluded.

This is the same principle `docs/02-architecture.md` §7 already states for
principle 1, applied to a different kind of unreliability: "a broken
source does not bring down the pipeline" becomes "an uncalibrated
heuristic does not silently discard a posting." An occasional duplicate
notification for a genuine repost is a real but bounded cost — one extra
line in the digest. A genuinely distinct opening silently and permanently
excluded, discovered only by accident as Amendments 1 and 2 both were, is
the worse and unbounded one.

**`restoreDuplicate`** (`PostingsRepository.restoreDuplicate`, CLI
`restore-duplicate <fingerprint>`) is the scoped counterpart to the blunt
`dedup --reset` Amendment 1 introduced: clears one posting's flag rather
than every flag in the corpus. It exists for flags a pre-shadow-mode
`dedup` run already set — shadow mode itself never calls `markDuplicate`,
so nothing new needs it going forward, but a legacy flag is still a real
posting silently withheld until someone undoes it.

**What this does not fix.** Shadow mode does not calibrate the threshold —
it makes calibration possible, by turning every future candidate into a
reviewable, auditable, reversible record instead of a silent exclusion. If
enough shadow candidates accumulate that a human labels a batch of them
"same job" / "different job," that becomes the real calibration data this
ADR has been missing since 2026-08-14 — genuinely M10 market-analysis
work, over real labelled data, not attempted here. Until then, this
project does not act on layer 2's output at all beyond logging it; layer 1
(the fingerprint's unique index) remains the only dedup mechanism that
excludes anything automatically.

**Consequence for AC-005's atomic dedup+claim barrier (ADR-040/PR-004).**
That barrier's atomicity is still real and still matters — it prevents a
concurrent external ingest from landing mid-transaction, unseen by either
the dedup scan or the scoring claim. What it no longer does is prevent a
near-duplicate from _reaching_ scoring: since layer 2 excludes nothing,
both postings in a near-duplicate pair are claimed and scored, and the
digest may show both. `executeDeliver` still runs the scan on every call,
atomically with the claim, and the `posting_events` row it produces is
still recorded inside that same transaction — auditability, not exclusion,
is what the atomicity now protects for layer 2's output.

**Reversal cost:** the algorithm and its thresholds are untouched by this
amendment — reverting to destructive merging is restoring the single
`repository.markDuplicate(...)` call `dedupSimilarPostings` used to make
on a match, in place of the `shadowCandidates.push(...)` it makes now. The
`ShadowDuplicateCandidate` shape, `posting_events` rows, and
`restoreDuplicate` stay useful either way — as an audit trail if merging
stays destructive, or as the shadow log if it stays advisory.
