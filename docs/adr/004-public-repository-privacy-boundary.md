# ADR-004 — Draw an explicit privacy boundary for a public repository

## Status

Accepted

## Date

2026-08-14

## Context

The repository is public, because its secondary goal is to be read as portfolio
work. The system it contains handles a complete resume, a phone number, an
e-mail address, a Telegram bot token, LLM API keys, a database of collected
postings, and raw API captures that may embed recruiter names and contact
details.

A public repository with personal data in its history is not fixable by deleting
the file later: the content stays in the history, and on a repository that has
been cloned or forked it stays everywhere. The only reliable control is to never
commit it in the first place.

The risk is highest at the start, when the repository is nearly empty and a
`git add .` is the natural way to stage the first files.

## Considered options

### Private repository

Rejected. It would eliminate the risk and the secondary goal along with it.

### Public repository, exclusions added as each file type appears

Rejected. This is the default path and it fails at exactly one moment — the first
commit after creating `config/profile.yaml`, before anyone has thought about the
`.gitignore`. The window is small and the failure is permanent.

### Public repository, exclusions committed before any other content

Accepted. The `.gitignore` goes in as the first content commit, listing files
that do not exist yet. There is then no point in the repository's history at
which a sensitive file could be staged by a wildcard.

## Decision

The `.gitignore` is committed before any other project file and covers, from
that moment:

```
config/profile.yaml       # phone, e-mail, full resume
config/profile.*.yaml     # with !config/profile.example.yaml
*.db  *.sqlite  data/     # collected postings and run history
.env  .env.*              # with !.env.example
test/fixtures/*-raw.json  # raw API captures
```

**Publishable:** architecture, algorithms, weights, prompts, the profile
_schema_, aggregate calibration results, and course start and end dates — the
last because the academic-period derivation cannot be documented or tested
without concrete boundary values, and those dates are already public on the
resume and portfolio site.

**Not publishable:** contact details, resume prose, the profile's evidence
entries, any token or API key, collected postings, and the hand-labelled
calibration set.

`config/profile.example.yaml` is committed with fictional data and the complete
structure, so the schema is demonstrable without the content. It lands in M2
alongside the Zod schema that defines it — committing a placeholder earlier would
produce an example that goes stale immediately.

Every pull request verifies:

```bash
git ls-files | grep -iE 'profile\.ya?ml|\.env|\.db$|\.sqlite|-raw\.json'
```

## Consequences

- No sensitive file is ever staged by a wildcard, at any point in the history.
- A fresh clone does not run. Setup requires copying the example profile and
  filling it in, which is a documentation obligation in the README rather than an
  accident.
- Raw API fixtures are gitignored, so CI cannot use them and adapter tests must
  run against curated, anonymized fixtures instead. This is a real constraint on
  M3, and the reason the tolerant Zod schema matters: the schema is what CI can
  test, the raw capture is what shapes it.
- The commit author e-mail remains in git history. That is inherent to any GitHub
  commit, already public, and out of scope for this boundary.
- The distinction between publishable and non-publishable data is now written
  down, so it can be applied consistently instead of re-argued per file.
