# ADR-011 — Pre-filter rules, ordering, and the unknown-axis leniency rule

## Status

Accepted — amended 2026-08-15, see
[Amendment 1](#amendment-1--2026-08-15-title-rules-match-whole-words-not-substrings)
and
[Amendment 2](#amendment-2--2026-08-15-track-keywords-match-whole-words-too)

## Date

2026-08-14

## Context

`docs/02-architecture.md` names six pre-filter rules and defers their exact
behavior and ordering to M5: "Rules and thresholds get an ADR in M5." Three
questions had no answer anywhere before this milestone:

1. What happens when `location` or `workMode` is `unknown` — a real
   possibility now that both are separate axes (`05-domain-model.md`) and
   Gupy does not always state a work mode?
2. In what order do six rules run, given each rejection records exactly one
   reason (`05-domain-model.md`, "rejection is always recorded with a
   reason")?
3. What does "minimum keyword adherence" check against, given `Posting` has
   no full description field?

## Decision

### The six rules, in this order

| #   | Rule                      | Rejects when                                                            |
| --- | ------------------------- | ----------------------------------------------------------------------- |
| 1   | Title blocklist           | Title contains a blocked term (`sênior`, `pleno`, …)                    |
| 2   | Title required            | Title contains **none** of the required terms (`estágio`, `intern`, …)  |
| 3   | Blocked companies         | Company matches a configured blocklist entry                            |
| 4   | Expired                   | `applicationDeadline` is set and in the past                            |
| 5   | Location                  | See below                                                               |
| 6   | Minimum keyword adherence | Fewer than the configured floor of profile keywords appear in the title |

**Order is cheapest and most decisive first.** Rules 1–2 are single-field
string checks; 3–4 are single-field checks against configuration; 5 reads two
fields and has real branching logic; 6 scans the entire profile keyword list
against the title and is the only rule whose cost scales with an external
input's size. Putting it last means a posting that would fail on title alone
never pays for a keyword scan.

**Short-circuit at the first failure.** Every rejection records exactly one
reason — accumulating every failing rule was considered and rejected, since
pre-filter is a pass/fail gate, not a scoring formula where multiple partial
failures compound meaningfully (unlike stage C's coverage terms). A posting
failing both the title blocklist and the location rule reports
`title_blocked`; fixing the title would surface the location problem on the
next run, which is an acceptable cost for a simpler, faster, and more
predictable function.

### Location and `workMode`: reject only when both axes are known-bad

The rule is "Rio de Janeiro metro, or remote." With `location` and `workMode`
as independent axes (`05-domain-model.md`), a posting can be `unknown` on
either without being unknown on both.

**Rejected only when `workMode` is known and not remote, _and_ `location` is
known and not in the configured cities.** Either axis being `unknown` passes:

- `workMode: "unknown"` — the posting cannot be ruled out as remote, so it is
  not rejected on location grounds regardless of what the location field says.
- `location: { kind: "unknown" }` — the posting cannot be ruled out as being
  in the target region, so a known non-remote `workMode` alone does not reject
  it either.

This is the M5 requirement stated directly: `unknown` must not be silently
discarded (that would punish a data gap as if it were evidence of a bad fit,
the same reasoning `trackAlignment`'s non-zero `unknown` weight already
applies) or silently accepted (that would defeat the rule's purpose whenever
data is missing, which for `workMode` on Gupy is not rare).

### Minimum keyword adherence checks the title only

Considered checking a full description too. Rejected for this milestone:
`Posting` does not retain one (`05-domain-model.md` scopes it out), and
adding it would mean another domain and schema change beyond what this
milestone's own scope decisions already required (`applicationDeadline`, added
this same milestone once the expiry rule needed it). Title-only keeps the
rule's cost bounded and its behavior easy to reason about; revisit if
`insufficient_keyword_adherence` and `unknown` track classification turn out
to be common once there is real run data to measure against, the same
condition `classify-track.ts` names for its own title-only scope.

### Track classification is always computed, pass or fail

`PreFilterOutcome.tracks` is populated on a rejected posting, not only a
passing one. Classification is cheap and the result is useful independent of
the filter's verdict — M10's market analysis reads the whole corpus, not the
shortlist (`05-domain-model.md`).

## Consequences

- The unknown-axis leniency rule means a posting with no stated `workMode`
  from a city outside the target list still passes. This is deliberate — see
  the reasoning above — but it does mean the pre-filter's cut is smaller
  against a source that under-reports `workMode` than it would be against one
  that always states it. Worth watching if Gupy's `workMode` completeness
  changes.
- **The ~70% cut estimate is replaced with two measured numbers, not one** —
  97.1% against a nationwide collection, 84.2% against one narrowed to Rio de
  Janeiro server-side (`docs/02-architecture.md`, `scripts/measure-prefilter-cut.ts`).
  The gap between them is the actual finding: most of what the pre-filter cuts
  is geography, and geography is cheaper to filter at the source than after
  downloading it. Unlike the estimate it replaces, both numbers are
  reproducible on demand — re-run `npm run measure:prefilter` over the corpus
  any time and compare.
- `minKeywordAdherence` checking title-only rather than title+description is
  the shallowest of the six rules. If it proves too shallow to matter (every
  posting either has 0 or hits any nonzero floor trivially), that is itself a
  finding worth recording rather than silently leaving the floor at a
  value that never actually filters anything.
- Reversing the rule order is cheap — `applyPreFilter` is a straight-line
  function with no shared state between rules — but reversing the
  unknown-axis leniency decision is not: it would need re-evaluating every
  posting already in the corpus that passed because of it, not just a config
  change.

---

## Amendment 1 — 2026-08-15: title rules match whole words, not substrings

The original implementation matched `titleBlocklist` and `titleRequired` with
`String.includes` against the fingerprint normalizer's output. That was wrong,
and measurably so — not a style preference.

`normalize` (`posting/domain/fingerprint.ts`) strips punctuation without
inserting anything, so a title becomes one long accent-free string with no
reliable word boundaries. Two of the blocklist's entries are the Roman-numeral
seniority markers `III` and `IV`, and **"iv" is a substring of ordinary
Portuguese words that appear constantly in real internship titles**: _nível_,
_universitário_, _afirmativa_, _administrativo_, _civil_, _executivo_,
_diversas_.

Measured against the real 380-posting corpus (`npm run measure:prefilter`):

- **24 postings were wrongly blocked**, 9 of them genuine internships —
  including `Estágio Nível Superior - TI - Segurança da Informação`, squarely
  on-profile, killed by the "ív" in _Nível_.
- The same flaw ran in the opposite direction on `titleRequired`, where
  `intern` matched _interna_, _internos_ and _International_, admitting
  non-internships into LLM budget.
- Substring matching also silently missed the feminine _estagiária_, since
  `estagiário` is not a substring of it — two real remote postings, one of
  them a backend internship.

**Decision:** the two title rules match on whole words (or whole phrases, for
multi-word terms like `tech lead`), via a title-specific normalizer
(`prefilter/domain/title-match.ts`) that turns punctuation into a **space**
rather than deleting it. The fingerprint normalizer is untouched — it is
frozen (ADR-007: changing it rewrites every stored fingerprint and re-notifies
the whole corpus) and wants the opposite behaviour anyway.

**Deliberately not changed:** `classifyTrack` and `minKeywordAdherence` still
substring-match. Their term lists are full of punctuation variants — `back-end`,
`node.js`, `ci/cd`, `full-stack` — where deleting punctuation is the feature,
and neither list contains a short token that collides with a common Portuguese
word. The tradeoff lands the other way for them; that is a considered
difference, not an inconsistency left behind.

**Consequences.** Re-measured on the same corpus: 24 false blocks removed,
**zero** true blocks lost (`Analista III` still blocks — there `III` is its own
word), 3 false accepts removed, and the pre-filter's pass count moved 16 → 18.

The cost, accepted: a term now matches only as written, so inflected forms must
be listed explicitly in `config/criteria.yaml` — `estágio` no longer matches
`Estágios`. That is the right place for it (criteria are data, principle 3): a
plural added there is visible in `git log`, where a stemmer buried in code
would not be. `titleRequired` grew accordingly, including the feminine and
plural forms the old matching missed by accident rather than by decision.

The headline number barely moved because the title rules were never the binding
constraint — **geography is**, exactly as this ADR's own Consequences section
predicted ("most of what the pre-filter cuts is geography, and geography is
cheaper to filter at the source than after downloading it"). The corpus is
São Paulo-dominated because collection queries Gupy with no criteria at all;
that is a collection problem, addressed separately, not a pre-filter one. The
value of this amendment is correctness — postings that _are_ in Rio and _are_
on-profile no longer disappear because of a word like "Nível".

---

## Amendment 2 — 2026-08-15: track keywords match whole words too

Amendment 1 changed the title blocklist and required-term rules to whole-word
matching, and deliberately left `classifyTrack` and `minKeywordAdherence` on
substring matching. It justified that with this claim:

> neither list contains a short token that collides with a common Portuguese
> word

**That claim was wrong, and it was asserted without measuring.** Running the
newly added tech collection queries surfaced the counter-examples immediately:

| Posting                                 | Classified | Because                         |
| --------------------------------------- | ---------- | ------------------------------- |
| Estágio de Social Media                 | `security` | `soc` inside "**soc**ial"       |
| ESTAGIÁRIO JURÍDICO (SOCIETÁRIO)        | `security` | `soc` inside "**soc**ietário"   |
| Estágio em Design (Redes Sociais)       | `security` | `soc` inside "**soc**iais"      |
| Estagiário de Fisioterapia              | `dev`      | `api` inside "fisioter**api**a" |
| Estagiário de Direito \| Auster Capital | `dev`      | `api` inside "c**api**tal"      |

`soc` (Security Operations Center) and `api` are both legitimate track
keywords and both are substrings of ordinary Portuguese words. The damage was
not cosmetic: `trackAlignment` weights `dev`/`security` at 1.0 against
`unknown`'s 0.4, so each false positive inflated its posting's score by
`15 × 0.6 = 9` points — a physiotherapy internship scoring as if it were
back-end work.

**Decision:** `classifyTrack` matches whole words too, via
`keywordMatchesTitle` (`prefilter/domain/title-match.ts`). Because the track
lists genuinely depend on punctuation-insensitivity — `back-end`, `node.js`,
`ci/cd`, `full-stack` — a single whole-word pass is not enough, so it makes
two, either of which matches:

1. **word/phrase** over punctuation-as-space text, so `back-end` matches
   "Back-End Developer";
2. **collapsed word** over punctuation-deleted text (`normalize`, which keeps
   spaces), so `back-end` also matches "Backend Developer".

Neither pass can match `api` inside `fisioterapia`: in both, the candidate has
to occupy a whole word.

**Consequences.** Measured over the real corpus, on-track postings fell from
**14 to 8** — and that is the point. Six of the fourteen were false positives;
the eight that remain are all genuinely relevant (backend, web, DevOps,
middleware/infrastructure). The headline number got worse and the data got
true.

`minKeywordAdherence` still substring-matches, and this time the claim is
narrow enough to hold: its terms come from `profile.yaml` competency names and
aliases, which are multi-word or distinctive (`TypeScript`, `PostgreSQL`,
`Linux server administration`), and the rule is disabled at floor 0 anyway.
If it is ever enabled, re-check it against this same failure mode rather than
assuming — which is exactly the mistake Amendment 1 made.
