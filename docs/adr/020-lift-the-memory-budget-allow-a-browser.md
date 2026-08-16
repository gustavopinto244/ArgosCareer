# ADR-020 — Lift the memory budget, allow a headless browser

## Status

Accepted

## Date

2026-08-16

## Context

`CLAUDE.md` §5 carried a hard cap since M0: **~150 MB at rest, ~250 MB at
peak**. It was never about tidiness. Atlas is a shared mini PC with 7.1 GB and
no GPU, and the original plan put a local model on it (`OllamaScorer`). Paging
during inference destroys latency and can take the whole box down with it, so
the cap was really a guard against one specific failure.

Two things ended that. ADR-016 retired `OllamaScorer` — it never finished a
calibration pass, Ollama was never installed on Atlas, and `ApiScorer` calls a
hosted model over HTTP. And the real footprint was measured: **54.8 MiB at
rest** for the whole container after M10, against a cap of 150.

The cap then started costing something instead of protecting anything. Probing
sources for collection (2026-08-15/16) found that Indeed and Glassdoor both
answer an honest HTTP request with a Cloudflare "Security Check" — the only
route left for either is a real browser. A headless browser is 300 MB+, so the
budget forbade that class of source by arithmetic, without anyone deciding it
on the merits.

## Considered options

### Keep the cap, raise the number

Rejected. Any number would be as arbitrary as the one it replaced, and the
reasoning behind the original — protect against local-inference paging — no
longer maps to anything the system does.

### Drop the cap entirely, say nothing else

Rejected. Atlas genuinely is shared: `atlas-manager`, Nginx, cloudflared,
portfolio and task-manager sit beside this. A limit removed with no
replacement invites the next person to assume the machine is free.

### Drop the cap, name the real constraint (chosen)

No fixed budget. The constraint is that the box is shared and 6.1 GB is what
the neighbours leave free — with the expectation that a new workload is
measured with `docker stats` after it lands, not sized against a number
written before it existed.

## Decision

**No fixed memory budget.** `CLAUDE.md` §5 states the shared-machine
constraint and the real measurement instead.

**A headless browser is an allowed tool** where a source has no usable API.
HTTP first — faster, cheaper, and it does not break when a layout changes —
but a browser is no longer a budget violation.

## What this does NOT change

Three rules stand, and they are the ones that actually decide whether a source
is collectable:

1. **`robots.txt` is respected** (§6). This is what rules Glassdoor out, and it
   does so independently of any browser or budget question: its `robots.txt`
   explicitly disallows `/jobview/`, `/job-listing/details.htm?*`, and the
   paginated search paths `/Vaga/*_IP*` and `/Vagas/*_P*.htm*` — with their own
   comment saying so. A collector needs detail pages and pagination. Both are
   forbidden in writing.
2. **The `User-Agent` is honest** (§6). Lifting the budget permits running a
   browser; it does not permit lying about what is making the request.
3. **§3 is untouched.** No collector is ever authenticated with a personal
   LinkedIn session or cookies. That was never a resource decision.

## Consequences

**Easy:** a source with no API is now a question of engineering effort rather
than a budget violation ruled out in advance. Indeed and LinkedIn are
deliberately left open for the future on that basis.

**Hard, and worth naming precisely:** the risk moves from RAM to reputation.
A browser-driven collector that trips an anti-bot control gets the **IP**
blocked, and the IP is Atlas's — shared with portfolio, task-manager, and the
Tailscale-published API. A blocked address is not a container problem that a
restart fixes; it is a shared asset degraded for unrelated services. Anything
in that direction should be rate-limited far below what feels necessary and
tested from somewhere disposable before it runs from Atlas.

**Also true:** removing the cap removes an early warning. 54.8 MiB was
comfortable against 150; against "the box is shared" it is comfortable against
nothing in particular. `docker stats` after a deployment is now the check that
matters, and M8's habit of measuring for real rather than asserting is what
keeps this honest.

**Reversal cost:** trivial for the budget — it is a sentence in `CLAUDE.md`.
Not trivial for a blocked IP, which is why the paragraph above exists.
