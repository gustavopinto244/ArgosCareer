# 07 — Testing strategy

The project's success criteria include "score computation is deterministic and
unit-tested — the same inputs give the same number, forever". That is a testing
requirement stated as a product requirement, and it decides most of what follows.

## The constraint that shapes everything

ADR-004 gitignores `test/fixtures/*-raw.json`, because raw API captures may embed
recruiter names and contact details, and this repository is public.

**CI therefore cannot run against real captured responses.** That constraint was
recorded when the privacy boundary was drawn but never resolved, and it would
have surfaced as a surprise in M3. The resolution is below.

## Two kinds of fixture

|           | Raw capture                                 | Curated fixture                    |
| --------- | ------------------------------------------- | ---------------------------------- |
| Path      | `test/fixtures/*-raw.json`                  | `test/fixtures/*.json`             |
| Committed | **No** — gitignored                         | **Yes**                            |
| Source    | `npm run fixture:gupy` against the live API | Derived by hand from a raw capture |
| Content   | Whatever the API returned                   | Same _shape_, invented values      |
| Used by   | Schema discovery, local exploration         | Every automated test               |

**Curated fixtures are derived from raw captures, never invented from
imagination.** A fixture invented without ever seeing the API tests the schema
against its own assumptions, which proves nothing. The workflow is:

1. `npm run fixture:gupy` captures the real response (gitignored).
2. Inspect it, and shape the tolerant Zod schema to what is actually there.
3. Hand-derive a curated fixture with the same structure — same keys, same
   nesting, same nullability, same odd cases — and fictional values: invented
   company names, invented ids, no real contact details.
4. Commit the curated fixture. Tests run against it.

The derivation step is manual on purpose. An automated anonymizer would need to
be trusted to catch every personal field, and being wrong once on a public
repository is permanent.

**Every curated fixture records its provenance** in a sibling `.md` or a header
comment: which endpoint, captured when, and which real-world oddity it preserves
(a null where a string was expected, an empty array, an unexpected extra field).
Without that, a fixture becomes folklore that nobody dares change.

## What gets tested at which level

### Unit — the majority, and the fastest

Pure functions with no I/O. These are where the project's correctness actually
lives:

- **Score computation (stage C).** Every branch: blocking cap including
  `partial`, empty-category coverage, `lowConfidence`, verdict boundaries at
  exactly 45 and 70, `trackAlignment` lookup including `unknown` and multi-track.
- **Fingerprint normalization.** Accents, punctuation, casing, whitespace
  collapse, and the property that matters most: **the same input gives the same
  hash forever** (`05-domain-model.md` freezes this function once postings are
  persisted).
- **Academic period derivation.** The two boundary values that the 0-indexed
  month bug would break — August 2026 → period 2, March 2027 → period 3 — plus
  clamping to `[1, 8]` and dates before the course start.
- **Pre-filter rules.** Each rule in isolation, and the ordering.
- **Digest translation.** Every pair in the `06-glossary.md` table.

### Contract — every port implementation

The convention that failure is a value only holds if it is tested. **For each
adapter, assert that it does not throw** on: a non-200 response, a timeout, a
malformed body, an empty body, and a connection reset mid-response.

This is the test that protects principle 1, and it is easy to skip because the
happy path passes without it.

For `ScorerPort` specifically, ADR-006's policy needs its own cases: markdown
fences around the JSON, prose before the JSON, truncated JSON, a valid object
with an invented enum value, and `met` with `evidence: null` — which must come
back as `not_met`.

### Integration — narrow and deliberate

Real SQLite (a temporary file, not a mock) for persistence and migrations,
because an ORM mocked against itself tests nothing. Real Nest module wiring for
composition, to catch DI mistakes that unit tests cannot see.

### End-to-end — one, in M6

The vertical slice: curated Gupy fixture → SQLite → stub scorer → a Telegram
notifier double. One test proving the pipeline is connected. More than one at
this level buys little and costs a lot.

## What is never tested against a live service

**No test makes a network call to Gupy, LinkedIn, Indeed, Telegram or an LLM
API.** Not in CI, not locally, not "just this once".

Reasons, in order of severity: it makes the suite non-deterministic; it sends
traffic to third parties every time someone runs `npm test`, which violates the
polite-collector rules; it can burn API credits; and it turns a red build into a
question about someone else's uptime.

`npm run fixture:gupy` is the deliberate exception. It is a **script, not a
test** — never run by CI, run by hand when the schema needs checking.

## The LLM is not tested for output quality

Unit tests assert that stages A and B **handle** whatever a model returns —
valid, malformed, or empty. They never assert that a model returns a _good_
extraction, because that assertion would be non-deterministic and would fail for
reasons unrelated to the code.

Model quality is measured by the M7 calibration protocol against 50 hand-labelled
postings, which is a measurement run producing a table, not a pass/fail gate.
Keeping these separate is what stops a model swap from turning the test suite
red.

## Conventions

- Vitest, files in `test/`, named `*.test.ts`, mirroring `src/` structure.
- Supertest for HTTP surfaces once M9 adds them.
- **Test names state the behavior**, not the function. Write "caps the score at
  35 when a blocking requirement is partial", not "test calculateScore 3".
- **No snapshot tests for score output.** A snapshot records what the code did,
  not what it should do; it turns an unnoticed regression into an accepted diff.
  Assert the number and the reason.
- Coverage is not a gate. A percentage target rewards testing the easy code, and
  the pure functions above are the ones that matter.

## What CI runs

`npm ci` → `lint` → `format:check` → `typecheck` → `test`, on Node 22 and 24.

`npm test` currently carries `--passWithNoTests`. **That flag comes out in M1**,
with the first stage C test. Its presence is a marker that the project has no
code yet, and leaving it after M1 would let an empty suite pass silently.
