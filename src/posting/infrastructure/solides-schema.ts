import { z } from "zod";

/**
 * Fitted to the response actually observed from
 * `https://apigw.solides.com.br/jobs/v3/portal-vacancies-new` — not a guess.
 * Captured with `npm run fixture:solides`; see
 * `test/fixtures/solides-jobs.json` for the curated, committed sample and its
 * provenance note.
 *
 * Tolerant on purpose (docs/05-domain-model.md): `.passthrough()` so an
 * unannounced new field survives into the raw payload instead of being
 * silently dropped, and every field but `id` and `title` is optional — this
 * is an undocumented third-party API, and a field present in every sample
 * today is not a guarantee it stays that way.
 *
 * `jobType` is kept as an open string rather than an enum: only `"presencial"`
 * has been observed across every sample pulled during discovery (RJ, 80
 * nationwide "estágio" results). A `"remoto"`/`"hibrido"` value is expected
 * to exist — `homeOffice` is the boolean this schema and the normalizer
 * actually trust for the remote signal — but is not asserted here because it
 * was never seen.
 */
export const SolidesJobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    companyName: z.string().optional(),
    description: z.string().optional(),
    createdAt: z.string().optional(),
    homeOffice: z.boolean().optional(),
    jobType: z.string().optional(),
    city: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        name: z.string(),
        state_id: z.union([z.number(), z.string()]).optional(),
      })
      .nullable()
      .optional(),
    state: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        name: z.string().optional(),
        code: z.string().optional(),
      })
      .nullable()
      .optional(),
    redirectLink: z.string().optional(),
    slug: z.string().optional(),
    openPositions: z.number().optional(),
    currentState: z.string().optional(),
    isHiddenJob: z.boolean().optional(),
  })
  .passthrough();

export type SolidesJob = z.infer<typeof SolidesJobSchema>;

/**
 * Deliberately loose at the envelope level, same reasoning as
 * `GupyResponseEnvelopeSchema`: `data.data` is checked only for being an
 * array, and individual items are validated one at a time by the collector
 * via `SolidesJobSchema.safeParse`, so one malformed entry never invalidates
 * the whole page (principle 1).
 *
 * Nested one level deeper than Gupy's envelope
 * (`{ success, data: { data: [...], count, totalPages } }`, not
 * `{ data: [...] }`) — an observed, not assumed, shape.
 */
export const SolidesResponseEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    data: z
      .object({
        data: z.array(z.unknown()),
        count: z.number().optional(),
        totalPages: z.number().optional(),
        currentPage: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
