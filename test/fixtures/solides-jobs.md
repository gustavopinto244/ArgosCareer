# Provenance — `solides-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from a
raw capture, never invented from imagination, and every one records where it
came from.

- **Endpoint:** `GET https://apigw.solides.com.br/jobs/v3/portal-vacancies-new`
- **Query:** `title=estagio&locations=Rio+de+Janeiro+-+RJ&take=10&page=1`
- **Captured:** 2026-08-17, via `npm run fixture:solides`
- **Derived from:** `test/fixtures/solides-raw.json` (gitignored, not
  reproducible from this repository — re-run the script to get a fresh one)

## Discovery notes that shaped the schema

The endpoint was not documented anywhere — found by opening
`https://vagas.solides.com.br/vagas/rio-de-janeiro-rj` in a real browser and
reading the network requests it made. The page itself (a Next.js SPA) embeds
no job data in its HTML or in its own `_next/data/*.json` payload; the real
list is fetched client-side from this API after load.

`take` is not configurable in practice: values other than `10` were verified
against the live API to silently return `{ data: { count: 0, data: [] } }`
rather than an error or a clamp. `SolidesCollector` hardcodes page size to 10
for this reason, not as a default.

## What this fixture preserves from the real capture

All 4 items here came back from a query filtered to `title=estagio` and
`locations=Rio+de+Janeiro+-+RJ`, so within that narrow slice:

| Oddity                                                        | Preserved as                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `description` length varies enormously (97 to several thousand chars, some carrying raw HTML) | Item `900088` (97 chars) and `904171` (4,809 chars) |
| Same `title` text reused across two different postings (`899836`/`899839`, "ESTAGIÁRIO(A) HOTELARIA" at two locations) | `899836` kept as the representative of the pair |

**Not observed in this capture, so not represented:**

- `homeOffice: true` — every item pulled during discovery (this fixture's
  city-scoped sample, plus ~80 items scanned nationwide for `title=estagio`)
  had `homeOffice: false`.
- Any `jobType` value other than `"presencial"`.
- A missing `companyName`, `city`, or `description` field — present on every
  item observed so far.

If a future capture shows any of these, this fixture should gain a real
example rather than one being guessed now (`solides-schema.ts`'s own comment
makes the same point about `jobType`).

## A real-world data-quality note, not a fixture concern

While discovering this API, one posting encountered live (not one of the four
curated here) had a `description` field polluted with what looks like an
accidentally-pasted HTML dump of a ChatGPT conversation page — no directive
content, just malformed markup mixed into otherwise-real job text. Not
represented in this fixture (none of the four curated items has it), but
worth remembering when `description` reaches Stage A: this source's HTML is
not guaranteed clean.
