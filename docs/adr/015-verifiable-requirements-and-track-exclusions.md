# ADR-015 — Score only what a candidate could evidence, and stop matching homonyms

## Status

Accepted

## Date

2026-08-15

## Context

ADR-014 fixed the inputs to the first calibration run. This ADR is the review
of the scoring **rules** themselves against the same 16 hand-labelled postings,
which is the first time the model's assumptions could be checked against a
human judgment instead of argued from first principles.

Two rules failed that check, each measured rather than suspected.

### `trackAlignment` carried no signal

Correlation between `trackAlignment` and hand score across the 16 labelled
postings: **-0.022**. Not weak — absent. The classifier was wrong in both
directions:

- **False positives.** `dev` lists "desenvolvimento" and `security` lists
  "segurança". "ESTAGIÁRIO DE DESENVOLVIMENTO DE EMBALAGENS" (packaging) and
  "ESTÁGIO - SEGURANÇA DO TRABALHO" (occupational safety) both scored the
  maximum 1.0 alignment against hand scores of 0. Across the full 523-posting
  corpus, **98 postings (19%)** were classified `dev` or `security` on these
  two words alone — "Desenvolvimento Infantil", "Treinamento e
  Desenvolvimento", "Desenvolvimento de Motoristas", "Desenvolvimento
  Imobiliário".
- **False negatives.** Six postings hand-scored 90–100 classified as
  `unknown` (0.4).

The false positives are unambiguous defects under any reading: packaging
development is not software development, and occupational safety is a
different profession from information security. The false negatives are not a
defect — see "the labelling tension" below.

### Unfalsifiable requirements were scored as failures

**28% of all `mandatory` and `blocking` requirements** extracted from the
labelled corpus were personal traits: "dinamismo", "proatividade", "boa
capacidade de comunicação oral e escrita", "facilidade para trabalhar em
equipe", "vontade de aprender".

No portfolio can evidence those. Stage B correctly answered `not_met` on every
one — ADR-005 forbids inventing a quote — and stage C counted each as a zero
in `mandatoryCoverage`, which carries 65 of the 100 points. The penalty landed
hardest on the postings judged best: the Anbima DevOps internship scored
**40.1 against a hand score of 100** with 5 of its 10 mandatory requirements
being traits; the Smarthis programme scored **21.1 against 100** with 3 of 6.

The score is supposed to answer "does this profile meet what the posting
declares". A trait requirement has no discriminating power — every candidate
asserts it, none can prove it — so counting it as a failure measures whether a
CV happens to contain the word "proativo".

## Considered options

### Add trait evidence to the profile ("sou proativo, trabalho bem em equipe")

Rejected. It would make the numbers move without making them mean anything,
and it corrupts the one thing ADR-005 protects: that every `met` is backed by
a checkable quote. The profile would start asserting what it cannot support,
which is the failure mode the evidence rule exists to prevent.

### Count non-verifiable requirements as `met` instead of excluding them

Rejected. "Nobody can evidence this" is not "the candidate satisfies this".
Awarding the points inflates every posting equally, which is the same as
awarding none — except it also hides the requirement from the digest. Excluding
them keeps the coverage ratio honest about what was actually assessed.

### Detect traits in stage C by category or keyword

Rejected. The `category` field is free-form model output — "soft_skill",
"interest", "learning willingness", "other" all appeared for the same kind of
requirement — and a Portuguese keyword list in stage C would put natural
language matching inside the pure, deterministic stage. Stage A already reads
the posting; asking it one more narrow question is where the judgment belongs.

### Lower `trackAlignment`'s 15-point weight to match its measured -0.022

Rejected, and this is the tempting one. Reweighting would improve the
correlation immediately while leaving a classifier that calls a packaging
internship a software job. That is the same mistake ADR-014 declined to make
with the empty-description bug: tuning the formula to compensate for a broken
input hides the broken input. Fix the classifier; re-measure; then decide
whether the weight is still wrong.

### Broaden the track model to cover support and data roles

Rejected by the project owner, deliberately, and recorded because it shapes
what the next calibration means. See below.

## Decision

**1. Requirements carry a `verifiable` flag.** Stage A (`a-v3`) judges, per
requirement, whether a candidate could demonstrate it with anything beyond
their own assertion, and answers `true` when unsure — silence must never be
able to delete a requirement. Stage C excludes non-verifiable requirements
from mandatory and desirable coverage, from blocking-failure detection (a
trait extracted as `blocking` would otherwise cap every such posting at 35
forever), and from `criticalGaps` (the study backlog should not contain "be
more proactive").

`lowConfidence` now counts **verifiable** requirements rather than all of
them. Excluding traits from coverage opens a hole this closes: a posting
asking only for "proatividade, dinamismo e boa comunicação" would take
coverage 1 from the empty-category rule and score near the top while looking
well-specified. Judged on what is actually checkable, it is exactly the vague
posting `docs/04`'s low-confidence rule was written for.

**2. `trackExclusions` veto a keyword match.** A per-track list of phrases in
`config/criteria.yaml`, checked before the positive keywords. Every entry was
observed as a real false positive in the collected corpus, not imagined.
"desenvolvimento de sistemas", "desenvolvimento backend", "desenvolvimento
web" and "análise e desenvolvimento de sistemas" are deliberately absent from
the exclusion list — they are genuinely dev.

## Consequences

- Stage A's cache is invalidated by the `a-v3` bump, so all 16 labelled
  postings re-extract. Roughly 16 calls; measurable now that ADR-014 prints
  usage.
- `verifiable` is optional on `Requirement` and absent means verifiable, so
  requirements cached under `a-v2` keep scoring exactly as before rather than
  silently vanishing from coverage.
- The trait rule depends on a model judgment that is not itself validated.
  If stage A marks a real requirement unverifiable, that requirement stops
  counting entirely — a quieter failure than the one being fixed, since it
  inflates rather than deflates. The prompt's tie-break ("when unsure, answer
  true") is the mitigation; whether it is enough is a question for the next
  calibration, and worth checking directly against the extractions rather than
  inferred from the correlation.
- Excluding traits raises scores across the board, so the `apply`/`review`
  thresholds — already provisional — are now measuring a different
  distribution and will likely need to move. They should not be re-tuned until
  a run with these rules exists to tune against.
- 98 corpus postings change track classification, which also affects the
  pre-filter, not only scoring. Expect the `unknown` share to rise; that is the
  classifier being honest rather than a regression.

### The labelling tension, unresolved on purpose

Asked whether the search profile should broaden to match the hand labels, the
project owner chose to **keep `CLAUDE.md` §1 strict**: back-end and
information security first, infrastructure and automation second.

That decision leaves six of the sixteen labels — Service Desk (90), Suporte a
Sistemas N1 (90), Análise de Dados (90), Data Analytics (90), Contabilidade
com Dados e IA (90), and a generic internship programme (100) — describing
postings that fall outside the scope the system is now being asked to enforce.
A correctly-behaving system will score them low, and the correlation will
punish it for being right.

The labels, not the rules, are what should change. Re-labelling those six
against the strict scope is the cheapest way to make the next calibration
measure the model instead of measuring a disagreement about scope. Recorded
here rather than acted on, because a hand label is the one input in this system
that only its owner may write.
