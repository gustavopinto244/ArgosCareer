import { z } from "zod";

/**
 * Fitted to `python-jobspy`'s real output — not a guess. Captured
 * 2026-08-16 via `scrape_jobs(site_name=["indeed"], ...)` against
 * `country_indeed="Brazil"`; see `test/fixtures/indeed-raw.json` for the
 * committed (gitignored) sample and CLAUDE.md §15's protocol.
 *
 * Tolerant on the same terms as `GupyJobSchema`/`CieeVagaSchema`:
 * `.passthrough()` so an unannounced column survives into the raw payload,
 * and every field but `id`/`title`/`company` optional. jobspy's own output
 * is a pandas DataFrame serialized to JSON — 33 columns observed, most
 * (`salary_source`, `min_amount`, `skills`, `company_rating`, `emails`,
 * `experience_range`, and more) null or empty in every one of the 8 sampled
 * rows. This is not this project's contract to keep; it is jobspy's own
 * output shape, which can change on a `pip install --upgrade` this project
 * does not control the timing of.
 *
 * Two fields carry real weight and are worth naming:
 *
 * - **`location` is one free-text string** ("Rio de Janeiro, RJ, BR"), not
 *   structured fields the way Gupy states `city` directly — the normalizer
 *   has to parse it, unlike Gupy's or CIEE's location handling.
 * - **`date_posted` is present and real** on every sampled row — unlike
 *   CIEE (`docs/11-known-issues.md` B1), this source does not need the
 *   `firstSeenAt` fallback ADR-011 Amendment 4 exists for.
 */
export const IndeedJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1).nullable().optional(),
    location: z.string().nullable().optional(),
    job_type: z.string().nullable().optional(),
    is_remote: z.boolean().nullable().optional(),
    date_posted: z.string().nullable().optional(),
    job_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

export type IndeedJob = z.infer<typeof IndeedJobSchema>;
