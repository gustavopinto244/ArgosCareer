# Provenance — `gupy-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from a
raw capture, never invented from imagination, and every one records where it
came from.

- **Endpoint:** `GET https://employability-portal.gupy.io/api/v1/jobs`
- **Query:** `jobName=estágio&limit=10`
- **Captured:** 2026-08-14, via `npm run fixture:gupy`
- **Derived from:** `test/fixtures/gupy-raw.json` (gitignored, not
  reproducible from this repository — re-run the script to get a fresh one)

## What this fixture preserves from the real capture

All 10 items in the raw capture came back `type: "vacancy_type_internship"`,
since the query filtered on `jobName=estágio`. Within that, three real
structural oddities were observed and are represented here:

| Oddity | Preserved as |
|---|---|
| `badges` present on some items, absent on others (not a nullable field — the key itself is sometimes missing) | Items 1 and 3 have `badges`; items 2 and 4 do not |
| `workplaceType` varies: `remote`, `hybrid`, `on-site` all appeared | One of each, plus a second `on-site` |
| `isRemoteWork` does not always agree with what you'd guess from the title | Item 1 (`remote`) has `isRemoteWork: true`; item 2 (`hybrid`) has `isRemoteWork: false` |

`skills` was an empty array on every one of the 10 real items — no populated
example exists here because none was ever observed. If a future capture shows
a non-empty `skills` array, this fixture should gain an example of it rather
than one being guessed now.

**Not observed in this capture, so not represented:** a `null` value for
`applicationDeadline`, `city`, `state` or `country`. The schema
(`src/posting/infrastructure/gupy-schema.ts`) accepts `null` for these
defensively — an undocumented third-party API earns that tolerance — but that
is a design choice, not something this fixture claims to have seen.

**Not from this capture, from separate manual exploration (not saved as a raw
capture):** three additional `type` values —
`vacancy_type_effective`, `vacancy_type_talent_pool`, `vacancy_legal_entity` —
turned up when querying without the `jobName` filter. Not represented in this
fixture since they weren't part of what was captured and saved; recorded
instead as a code comment in `gupy-schema.ts`, which is why `type` stays an
open string rather than an enum.

## What is fictional

Every `id`, `companyId`, `careerPageId`, name, URL and description. No real
company, no real posting, no real recruiter is represented here — this file
is committed and public.
