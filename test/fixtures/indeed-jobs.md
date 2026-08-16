# Provenance — `indeed-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from a
raw capture, never invented from imagination, and every one records where it
came from.

- **Tool:** `python-jobspy`, `scrape_jobs(site_name=["indeed"], ...)`
- **Query:** `search_term="estagio desenvolvimento"`,
  `location="Rio de Janeiro, Brazil"`, `country_indeed="Brazil"`,
  `results_wanted=8`
- **Captured:** 2026-08-16, via an ephemeral `python:3.12-slim` container
  (the same strategy CLAUDE.md §6 names for this source), not through this
  repository's code — there is no `fixture:indeed` npm script, since
  collection for this source happens outside this process entirely
  (ADR-027)
- **Derived from:** `test/fixtures/indeed-raw.json` (gitignored, not
  reproducible from this repository without the same container run)

## What this fixture preserves from the real capture

Four structural facts, all observed across the 8 real rows, none invented:

| Fact | Preserved as |
| --- | --- |
| `location` is one free-text string ("City, State, Country"), never structured fields the way Gupy states `city` directly | Every item's `location` |
| `job_type` does not reliably say "internship" even for a posting that plainly is one — 3 of the 8 real Baker Hughes internships reported `job_type: "parttime"` | Item 3 |
| `job_type` can be a comma-joined list of more than one value | Item 4, `"parttime, internship"` |
| `is_remote` varies genuinely — not every internship in the real sample was on-site | Item 1 (`false`) and item 2 (`true`) |

**33 columns were observed on the real payload; most were null or empty on
every one of the 8 sampled rows** — `salary_source`, `min_amount`,
`max_amount`, `currency`, `job_level`, `job_function`, `listing_type`,
`emails`, `company_url_direct`, `company_addresses`, `company_industry`,
`company_num_employees`, `company_revenue`, `company_description`,
`company_logo`, `company_rating`, `company_reviews_count`,
`vacancy_count`, `work_from_home_type`, `experience_range`, `skills` were
`null` in all 8. Represented here as `null` throughout — a populated example
of any of these does not exist in what was actually captured, so none is
guessed here (`CLAUDE.md` §15).

**`date_posted` was present and parseable on every one of the 8 real
rows** — unlike CIEE (`docs/11-known-issues.md` B1), this source states a
real publication date. Represented here as always-present, matching what was
observed; the schema (`indeed-schema.ts`) still treats it as optional and
the normalizer still tolerates an unparseable value, the same defensive
posture every other source's normalizer takes with an undocumented
third-party field.

**Not observed in this capture, so not represented:** `job_url_direct` was
non-null on 1 of 8 real rows (the rest were empty string, not `null` —
distinct from the schema's `.nullable()`). Item 1 here represents that case;
the rest use `null` for simplicity, since the normalizer does not read this
field at all (only `job_url` is mapped to `sourceUrl`).

## What is fictional

Every `id`, company name, URL and description. No real company, no real
posting, no real recruiter is represented here — this file is committed and
public. The real captured company names (visible only in the gitignored
`indeed-raw.json`) do not appear anywhere in this repository's history.
