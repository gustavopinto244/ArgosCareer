# ADR-028 — Accept, deliberately, that Indeed via jobspy breaks two collector rules

## Status

Accepted. A named, scoped exception to CLAUDE.md §6, not a change to the
rule itself — see Decision.

## Date

2026-08-16

## Context

ADR-027 built the receiving side for Indeed collection and verified
`python-jobspy` gets past the Cloudflare check ADR-020 found blocking
direct HTTP. It did not yet look at _how_ jobspy gets past it. Checked
before writing the collection script, not assumed:

**1. jobspy's Indeed scraper sends a hardcoded, forged User-Agent
impersonating Indeed's own mobile app.**
`jobspy/indeed/constant.py`: `"user-agent": "Mozilla/5.0 (iPhone; CPU
iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)
Mobile/15E148 Indeed App 193.1"`. The `Indeed` scraper class accepts a
`user_agent` constructor parameter, which looked like an escape hatch —
tested directly by passing an honest, identifying one
(`ArgosCareer/0.1.0 (+https://github.com/...)`) through `scrape_jobs()`.
It still returned results. Read the source before trusting that: the
parameter is stored on the base `Scraper` class but the Indeed subclass's
actual request code builds its headers from the module-level `api_headers`
constant directly, never from `self.user_agent`. The parameter is a no-op
for this site. **There is no way, through jobspy's public API, to make
Indeed collection use an honest identity.**

**2. The exact host jobspy queries disallows all crawling, unconditionally.**
`self.api_url = "https://apis.indeed.com/graphql"` — and
`https://apis.indeed.com/robots.txt` is `User-agent: * / Disallow: /`. Every
path, every agent, no exception.

Both directly contradict CLAUDE.md §6: "`robots.txt` is respected... an
honest `User-Agent` that identifies what it is — never forged to imitate a
browser." **This is not a new question for this project.** ADR-020 already
ruled out Glassdoor on the first of these two grounds alone: "`robots.txt`
is respected — this is what rules Glassdoor out, and it does so
independently of any browser or budget question." Indeed's `apis.indeed.com`
is the same shape of fact, and until this ADR the precedent was to treat it
as absolute — no exception considered for Glassdoor, none built into the
rule itself.

**This was surfaced to the user as two separate decisions, not one**,
because the second fact changed the weight of the first: asked once about
the forged User-Agent alone, then asked again with the `robots.txt` finding
added, explicitly naming the Glassdoor precedent as the contrary case. Both
times, the answer was to proceed. This ADR records that decision and its
full reasoning — it does not make the decision itself.

## Considered options

### Abandon Indeed as a source (the Glassdoor precedent)

The consistent option, and the one this ADR does not choose. Costs nothing:
ADR-027's receiving endpoint stays in place, inert, reusable for a future
source that does not require this trade. Rejected by the user, deliberately,
after the trade-off was stated plainly twice.

### Patch jobspy's installed package to remove the forged header

Considered and not pursued. It does not resolve the ethical question, it
relocates it — the request would still be Indeed-app-shaped in every way
that matters to Indeed's own detection, just constructed by different code.
It also does nothing for the `robots.txt` finding, which has nothing to do
with headers at all. And it means carrying a local patch against a
third-party dependency indefinitely, breaking silently on any `jobspy`
upgrade.

### Accept both violations, scoped narrowly to this one library and this one host (chosen)

## Decision

**CLAUDE.md §6 gains one named exception**, not a general loosening of the
rule: `python-jobspy`'s Indeed scraper, querying `apis.indeed.com`
specifically, is permitted to operate outside the honest-`User-Agent` and
`robots.txt` requirements every other collector in this project must
follow. The exception is scoped to that one library's Indeed code path —
it licenses nothing else, for any other source, present or future. A
collector added later that wants the same latitude needs its own ADR
making the same case, not a citation of this one.

**Why here and not Glassdoor, stated honestly rather than glossed over:**
there is no principled technical distinction between the two — both are a
`robots.txt: Disallow: /` on the host actually queried. The difference is
that a working path exists for Indeed (`jobspy`, however it gets there) and
none was found for Glassdoor (ADR-020's own investigation: detail pages and
pagination are both explicitly disallowed, with no library offering a route
around it). This is a decision made on the merits of what is achievable,
not a claim that Indeed's `robots.txt` matters less than Glassdoor's.

**What is _not_ excepted, and stays enforced:** LinkedIn (CLAUDE.md §3,
non-negotiable, no ADR can override it), every other collector's honest
identity and `robots.txt` compliance, and the ~1.5 s politeness interval —
jobspy's own request pacing to Indeed is outside this project's control,
same as its header, but nothing here licenses this project's _own_ code to
hammer anything.

## Consequences

**Easy:** ADR-027's endpoint and normalizer need no changes — they already
treat the source as "already-fetched postings arrive from outside this
process," agnostic to how they were fetched. The host script (next PR) can
now be written without a second stop for this question.

**The real cost, named plainly:** this project now knowingly sends
requests Indeed's own `robots.txt` says not to send, identified as Indeed's
own app when they are not. If Indeed detects and blocks it, the block lands
on **Atlas's IP** — shared with `atlas-manager`, `portfolio`, `task-manager`,
and the Tailscale-published API (the same reputation risk ADR-020 named for
a browser-driven collector, sharper here because deliberately defeating
detection makes discovery more likely to matter to Indeed, not less). A
block is not a code problem a restart fixes; it degrades a shared address
for services that have nothing to do with this one.

**Reversal cost: low, and the same escape hatch ADR-020 built stays valid.**
Removing Indeed collection is deleting the host script and its scheduling;
the receiving endpoint and the CLAUDE.md exception can be deleted with it,
or simply left inert.

**This is a portfolio project's judgment call, made by its owner, about
its owner's own tooling** — not a claim that this reasoning generalizes to
scraping other people's data at scale, which CLAUDE.md's non-goals already
rule out for unrelated reasons.
