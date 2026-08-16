# Provenance — `ciee-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from a
raw capture, never invented from imagination, and every one records where it
came from.

- **Endpoint:** `GET https://api.ciee.org.br/vagas/vitrine-vaga/publicadas`
- **Query:** `size=100&page=0..2` (the endpoint ignores every filter parameter
  tried — see below)
- **Captured:** 2026-08-16, via `npm run fixture:ciee` — 300 real postings
- **Derived from:** `test/fixtures/ciee-raw.json` (gitignored, not
  reproducible from this repository — re-run the script to get a fresh one)

## Where this endpoint came from

It is not documented. It was found by reading the lazy-loaded chunks of the
CIEE portal's own Vite bundle (`assets/FiltroVagas-*.js`), which reference
`/api/portal/buscar_filtro_vagas` and, on the vagas host,
`vagas/vitrine-vaga/publicadas`. It answers unauthenticated `GET` requests and
returns a Spring-style paginated envelope.

`robots.txt` permits it: the file's only directive is `Disallow:` (empty),
which allows everything. Checked 2026-08-16.

## What this fixture preserves from the real capture

Four postings, each chosen because it exercises a branch the normalizer
actually has:

| Case | Preserved as | Why it matters |
| --- | --- | --- |
| `nivelEscolar: "SU"` in Rio de Janeiro | `9000001` | The only shape the collector keeps by default |
| `nivelEscolar: "EM"` | `9000002`, `9000003`, `9000004` | Must be filtered out — ineligible, not merely low-scoring |
| `requisitos.semestreInicio: null` | `9000003` | 5 of 300 real postings had no semester window |
| `bolsaAuxilio: null` | `9000004` | Stipend is genuinely absent sometimes |
| `local.bairro: null` | `9000004` | Sub-fields of `local` vary independently |

**Observed across all 300 and preserved in shape:** `local.tipoLogradouro`,
`endereco`, `numero`, `complemento` and `cep` were `null` on every single
posting — CIEE publishes neighbourhood and city, never a street address.
`requisitos.escolas` was `null` on all 300.

**Three absences are the important part**, and they were verified across the
whole 300-posting capture rather than assumed:

- **No publication date field of any kind.** This is why `publishedAt`
  normalizes to `null` and CIEE postings always pass the recency window
  (ADR-019).
- **No remote / work-mode flag.** This is why `workMode` is `unknown`.
- **No job title.** `descricao` is the *company's line of business*
  ("Ensino fundamental", "Serviço de táxi aéreo"); the role category lives in
  `areaProfissional` ("Informática"). Confusing the two inflates any keyword
  measurement built on it — which happened once while sizing this source, and
  is why both this note and `ciee-schema.ts` say so explicitly.

**Not observed, so not represented:** a `tipoVaga` other than `"ESTAGIO"`
(all 300 were internships), a `null` `local`, and an empty `atividades`
array. The schema tolerates all three defensively — an undocumented internal
API earns that — but this fixture does not claim to have seen them.

## What is fictional

Every `codigoVaga`, `nomeEmpresa`, `areaProfissional` value that named a real
employer, `descricao`, `atividades` entry, city, neighbourhood and logo URL.
No real company and no real posting is represented here — this file is
committed and public (ADR-004).

What is **not** fictional is the *shape*: which fields are present, which are
`null`, and how they co-vary. That is the whole point of deriving a fixture
from a capture instead of writing one from imagination.
