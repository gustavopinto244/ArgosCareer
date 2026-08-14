# Contributing

ArgosCareer is a personal project with one maintainer. This file exists because
the conventions need to be written down somewhere an agent or a future me can
read them — not because pull requests from strangers are expected.

Issues and questions are welcome. Feature pull requests are likely to be
declined: the scope is deliberately narrow and `docs/01-vision-and-scope.md`
lists what is out and why.

## Before anything

Read `CLAUDE.md`. It is the working agreement and it wins over habit.

Two rules there are absolute and worth repeating here:

- **No collector is ever authenticated with a personal LinkedIn session or
  cookies.** If a change appears to require it, stop and ask.
- **No personal data, token or API key is ever committed.** The repository is
  public. See `docs/adr/004-public-repository-privacy-boundary.md`.

## Setup

```bash
npm ci
cp .env.example .env                                # fill in secrets
cp config/profile.example.yaml config/profile.yaml  # from M2 onward
```

Node `>=22.12.0` — below that, `require(esm)` is behind a flag and the
`nodenext` module semantics this project relies on do not hold.

## The loop

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

That is exactly what CI runs, on Node 22 and 24. Run it before every commit, not
before every push — see below.

## Branches

`main` is protected. One branch per milestone:

```
feat/m3-gupy-collector
fix/dedup-accent-normalization
docs/m0-foundation
chore/m0-repo-hygiene
build/...   ci/...   test/...   refactor/...
```

Short, lowercase, hyphen-separated.

## Commits

Conventional Commits, **in English** (ADR-003), and **frequent**.

**Commit at every green checkpoint** — typecheck and tests passing — not at the
end of a milestone. A commit that leaves the repository broken does not go in,
because it makes `git bisect` useless exactly when it is needed.

```
feat(collector): add Gupy adapter with tolerant schema
test(scoring): cover blocking-requirement cap
docs(adr): record ADR-007 on stage re-execution
build(toolchain): switch module resolution to nodenext
```

The message describes **the resulting change**, not the process that produced
it. The body explains _why_, when why is not obvious from the diff.

## Pull requests

One per milestone, against `main`. **Over ~15 files, split it into two.**

The description states four things, per the template:

1. What changes
2. Why — which milestone, what it unlocks
3. How to test
4. **What is left out** — deferred scope, and anything that is an unverified
   assumption in this branch

Point 4 is the one that gets skipped and the one that matters most. An
unverified assumption shipped without a flag becomes a fact nobody remembers
doubting.

No green CI, no merge. Squash merge.

## ADRs

Every non-obvious decision becomes an ADR in `docs/adr/`, **in the same commit as
the code implementing it**. Copy `docs/adr/000-template.md`.

Two sections carry the value and are usually written badly:

- **Considered options** must include the alternatives that were genuinely
  plausible. An ADR listing one option and choosing it documents nothing.
- **Consequences** must include what the decision makes _harder_ and the cost of
  reversing it. Only-positive consequences mean the analysis is unfinished.

Accepted ADRs are immutable. New evidence that refines a decision gets an
**amendment**; a decision that is now wrong gets a **new ADR** that supersedes
it. `docs/03-technical-decisions.md` has the test for which applies.

## Code

- Comments explain **why**, not what.
- The domain layer imports no framework. That boundary is what keeps stage C
  testable without booting an application context.
- Ports return failure as a value — never throw across a port boundary
  (`docs/05-domain-model.md`).
- Decisions live in configuration, not in code (principle 3), and configuration
  is validated with Zod at startup and fails loudly.

## Tests

`docs/07-testing-strategy.md` is the full picture. The rules most often broken:

- **No test makes a network call** to Gupy, LinkedIn, Indeed, Telegram or an LLM
  API. `npm run fixture:gupy` is a script, not a test, and CI never runs it.
- **No snapshot tests for score output.** A snapshot records what the code did,
  not what it should do.
- Test names state the behavior: "caps the score at 35 when a blocking
  requirement is partial".

## Before pushing

```bash
git ls-files | grep -iE 'profile\.ya?ml|\.env$|\.db$|\.sqlite|-raw\.json'
```

Empty output, every time. On a public repository this is the check that cannot
be undone if it is skipped.
