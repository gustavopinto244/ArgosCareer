import { z } from "zod";

/**
 * Fitted to the response actually observed from
 * `https://api.ciee.org.br/vagas/vitrine-vaga/publicadas` — not a guess.
 * Captured with `npm run fixture:ciee` over 300 real postings; see
 * `test/fixtures/ciee-jobs.json` for the curated, committed sample and its
 * provenance note.
 *
 * Tolerant on the same terms as `GupyJobSchema`: `.passthrough()` so an
 * unannounced field survives into the raw payload, and everything but
 * `codigoVaga` optional. This is an internal API discovered from the
 * portal's own bundle — it carries no compatibility promise whatsoever, and
 * a field present in all 300 samples today is not a guarantee for tomorrow.
 *
 * Three absences are load-bearing and were confirmed across the whole
 * sample, not assumed:
 *
 * - **No publication date.** Nothing resembling one exists on the record, so
 *   `publishedAt` normalizes to null — which passes the recency window by
 *   ADR-019's rule that a missing date is not evidence of an old posting.
 * - **No remote/work-mode flag.** `workMode` normalizes to `unknown`, which
 *   ADR-011's leniency rule also lets through.
 * - **No job title.** `descricao` is the *company's line of business*
 *   ("Ensino fundamental", "Serviço de táxi aéreo"); the role lives in
 *   `areaProfissional` ("Informática"). Mistaking one for the other inflates
 *   any keyword count built on it — it happened once while measuring this
 *   source, which is why the distinction is written down here.
 */
export const CieeLocalSchema = z
  .object({
    // Street-level fields were null in all 300 observed postings — CIEE
    // publishes the neighbourhood and city, never the address.
    tipoLogradouro: z.string().nullable().optional(),
    endereco: z.string().nullable().optional(),
    numero: z.string().nullable().optional(),
    complemento: z.string().nullable().optional(),
    cep: z.string().nullable().optional(),
    bairro: z.string().nullable().optional(),
    cidade: z.string().nullable().optional(),
    uf: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * The academic window a posting accepts, in semesters. Present on 295 of 300
 * observed postings — the single most valuable field on this source, because
 * it is what `CLAUDE.md` §9's period-blocked digest section has needed since
 * M6 and never had from any source.
 */
export const CieeRequisitosSchema = z
  .object({
    semestreInicio: z.number().nullable().optional(),
    semestreFinal: z.number().nullable().optional(),
    escolas: z.unknown().nullable().optional(),
  })
  .passthrough();

export const CieeVagaSchema = z
  .object({
    codigoVaga: z.union([z.number(), z.string()]),
    // "ESTAGIO" in every observed posting, kept an open string for the same
    // reason GupyJobSchema keeps `type` open: one observed value is not an
    // enumeration.
    tipoVaga: z.string().optional(),
    nomeEmpresa: z.string().optional(),
    // "SU" (superior), "EM" (ensino médio), "TE" (técnico) observed.
    nivelEscolar: z.string().optional(),
    areaProfissional: z.string().nullable().optional(),
    areaAtuacao: z.string().nullable().optional(),
    descricao: z.string().nullable().optional(),
    atividades: z.array(z.string()).optional(),
    beneficios: z.array(z.unknown()).optional(),
    quantidadeBeneficios: z.number().nullable().optional(),
    bolsaAuxilio: z.number().nullable().optional(),
    bolsaAuxilioDe: z.number().nullable().optional(),
    bolsaAuxilioAte: z.number().nullable().optional(),
    salario: z.number().nullable().optional(),
    salarioDe: z.number().nullable().optional(),
    salarioAte: z.number().nullable().optional(),
    tipoAuxilioBolsa: z.string().nullable().optional(),
    tipoValorBolsa: z.string().nullable().optional(),
    tipoSalario: z.string().nullable().optional(),
    tipoSalarioValor: z.string().nullable().optional(),
    tipoHorario: z.string().nullable().optional(),
    horarioEntrada: z.string().nullable().optional(),
    horarioSaida: z.string().nullable().optional(),
    local: CieeLocalSchema.nullable().optional(),
    requisitos: CieeRequisitosSchema.nullable().optional(),
    logo: z.string().nullable().optional(),
  })
  .passthrough();

export type CieeVaga = z.infer<typeof CieeVagaSchema>;

/**
 * A Spring-style paginated envelope. Deliberately loose about `content`'s
 * items for the same reason `GupyResponseEnvelopeSchema` is: the collector
 * validates each posting on its own so one malformed entry never invalidates
 * a page of 100 (principle 1, at the item level).
 */
export const CieeResponseEnvelopeSchema = z
  .object({
    content: z.array(z.unknown()),
    totalElements: z.number().optional(),
    totalPages: z.number().optional(),
    number: z.number().optional(),
    size: z.number().optional(),
    last: z.boolean().optional(),
  })
  .passthrough();
