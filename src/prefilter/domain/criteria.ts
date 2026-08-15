import { z } from "zod";
import { ProfileTrackSchema } from "../../profile/domain/profile";

export const LocationCriteriaSchema = z.object({
  /** Case-insensitive city names the location rule accepts. */
  cities: z.array(z.string().min(1)).default([]),
  allowRemote: z.boolean().default(true),
});

/**
 * Stage C's inputs (`src/scoring/domain/types.ts`'s `ScoringConfig`, minus
 * `trackWeights` — that lives at the top level of `Criteria` already, shared
 * with the pre-filter's track classification rather than duplicated here).
 */
export const ScoringConfigSchema = z.object({
  weights: z.object({
    mandatory: z.number(),
    desirable: z.number(),
    trackAlignment: z.number(),
  }),
  thresholds: z.object({
    apply: z.number(),
    review: z.number(),
  }),
  minExtractedRequirements: z.number().int().nonnegative(),
  blockingCapScore: z.number(),
});

/**
 * `config/criteria.yaml`'s shape (docs/09-configuration.md). Committed, not
 * gitignored — criteria are neither secret nor personal, and committing them
 * is what makes "why did I stop seeing infra postings?" answerable with
 * `git log` (principle 3).
 *
 * `tracks` requires an entry for every `ProfileTrack` (Zod's record-over-an-
 * enum enforces completeness) — a track silently missing its keyword list
 * would classify every one of its postings as `unknown`, which is exactly
 * the kind of empty-filter-that-silently-passes-everything principle 3
 * warns against.
 */
export const CriteriaSchema = z.object({
  titleBlocklist: z.array(z.string().min(1)).default([]),
  titleRequired: z.array(z.string().min(1)).min(1),
  location: LocationCriteriaSchema,
  blockedCompanies: z.array(z.string().min(1)).default([]),
  /** Minimum count of profile keywords that must appear in a posting's text
   * before it is worth LLM budget. */
  minKeywordAdherence: z.number().int().nonnegative().default(0),
  tracks: z.record(ProfileTrackSchema, z.array(z.string().min(1))),
  /**
   * Phrases that veto a track even when one of its keywords matched
   * (ADR-015). Portuguese job titles overload exactly the two words this
   * project cares most about: "desenvolvimento" is packaging, product,
   * people or business development far more often than software, and
   * "segurança do trabalho" is occupational safety, a different profession
   * from information security. Both scored 1.0 track alignment on postings
   * hand-labelled 0.
   *
   * Optional and defaulted so an existing criteria file stays valid.
   */
  trackExclusions: z
    .object({
      dev: z.array(z.string().min(1)).default([]),
      security: z.array(z.string().min(1)).default([]),
      automation: z.array(z.string().min(1)).default([]),
    })
    .default({ dev: [], security: [], automation: [] }),
  trackWeights: z.object({
    dev: z.number(),
    security: z.number(),
    automation: z.number(),
    unknown: z.number(),
  }),
  scoring: ScoringConfigSchema,
});

export type Criteria = z.infer<typeof CriteriaSchema>;
export type LocationCriteria = z.infer<typeof LocationCriteriaSchema>;
export type ScoringConfigCriteria = z.infer<typeof ScoringConfigSchema>;
