import { z } from "zod";

/**
 * Fitted to the real shape an n8n workflow extracts from LinkedIn's job
 * alert emails (ADR-029) — never scraped, never authenticated (CLAUDE.md
 * §3). n8n parses the email HTML and pushes each posting through the same
 * ingest endpoint Indeed's collector uses (ADR-027).
 *
 * `.passthrough()`, matching every other source's tolerance discipline —
 * `Subject`, `ReceivedAt`, `ExtractedAt` from the real n8n table were
 * observed but are not part of this schema's required shape, since the
 * normalizer never reads them; a caller sending them is tolerated, not
 * required.
 *
 * **`location` is one bundled string** — `"Cidade, UF (Modo)"` or
 * `"Brasil (Remoto)"` — carrying both place and work mode together, unlike
 * every other source's separate fields. The normalizer is what splits them
 * (ADR-029); this schema just requires the string exist.
 */
export const LinkedinAlertJobSchema = z
  .object({
    title: z.string().min(1),
    company: z.string().min(1),
    location: z.string().nullable().optional(),
    link: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export type LinkedinAlertJob = z.infer<typeof LinkedinAlertJobSchema>;
