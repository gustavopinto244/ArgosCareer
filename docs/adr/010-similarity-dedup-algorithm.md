# ADR-010 — Character-bigram Dice similarity for layer 2 dedup, threshold 0.35

## Status

Accepted

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
- Character-bigram Dice is O(title length) per comparison and the grouping is
  O(n) per company — irrelevant at this project's volume, and would need
  reconsidering only if the corpus grew by orders of magnitude.
- Reversing the algorithm choice is cheap: `dedupSimilarPostings` depends only
  on `computeTitleSimilarity`'s signature (two strings in, a number out), so
  swapping the implementation later does not touch the repository or the CLI.
