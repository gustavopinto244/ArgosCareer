import { z } from "zod";

/**
 * Fitted to `application/ld+json` `schema.org/JobPosting` markup actually
 * observed on real `catho.com.br` posting pages (2 samples, both fetched
 * with a real Chromium browser — Catho blocks non-browser User-Agents on
 * this exact path with a plain 403, verified before this schema was
 * written). See `docs/adr/032-catho-collector-headless-browser.md` for the
 * full discovery record.
 *
 * Tolerant on purpose, same reasoning as every other source's schema here
 * (docs/05-domain-model.md): `.passthrough()`, only `title` required.
 *
 * `jobLocation[].address.addressLocality` is present in every sample but
 * **not trusted by the normalizer** — both real samples returned
 * `"São Paulo"` for postings actually located in Paulínia and Santos
 * (confirmed by each posting's own postal code and by three independent
 * page surfaces — `<title>`, `og:title`, meta description — that all agreed
 * with each other and disagreed with this field). Kept in the schema
 * because the field is real and present, just not the source of truth
 * `catho-normalizer.ts` reads from.
 */
export const CathoJobPostingLdSchema = z
  .object({
    "@type": z.string().optional(),
    title: z.string(),
    description: z.string().optional(),
    datePosted: z.string().optional(),
    employmentType: z.string().optional(),
    hiringOrganization: z
      .object({ name: z.string().optional() })
      .passthrough()
      .optional(),
    jobLocation: z
      .array(
        z
          .object({
            address: z
              .object({
                streetAddress: z.string().optional(),
                addressLocality: z.string().optional(),
                addressRegion: z.string().optional(),
                postalCode: z.string().optional(),
                addressCountry: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    baseSalary: z.unknown().optional(),
  })
  .passthrough();

export type CathoJobPostingLd = z.infer<typeof CathoJobPostingLdSchema>;

/**
 * The envelope `collectors/catho/collect.ts` (the external, host-side
 * Playwright script — never run inside this container, same shape as
 * ADR-027's Indeed collector) actually POSTs to `/runs/collect/external`.
 * Not the JSON-LD alone: `pageTitle` is required precisely because the
 * JSON-LD's own location field cannot be trusted (see the note above) — the
 * page `<title>` is what the normalizer actually parses the city from.
 *
 * `id` is the numeric ID embedded in the posting's sitemap URL
 * (`/vagas/<slug>/<id>/`), stable and independent of Catho's own internal
 * "offer" ID scheme, which the JSON-LD does not expose at all.
 */
export const CathoPostingEnvelopeSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    url: z.string().optional(),
    pageTitle: z.string().optional(),
    jobPosting: CathoJobPostingLdSchema,
  })
  .passthrough();

export type CathoPostingEnvelope = z.infer<typeof CathoPostingEnvelopeSchema>;
