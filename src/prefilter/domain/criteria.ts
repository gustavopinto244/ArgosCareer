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
 * One query issued to a collector. Mirrors the subset of
 * `GupyCollectorCriteria` that is a *search decision* rather than a
 * transport detail — `pageSize`, timeouts and backoff stay in the adapter.
 */
export const CollectionQuerySchema = z.object({
  jobName: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

/**
 * What the scheduled collection cycle actually asks the source for
 * (principle 3: search strategy is data, not code).
 *
 * Before this existed the cron called `executeCollect(db, collector, {})` —
 * an empty query — and Gupy answered with whatever it liked: 380 mostly-São
 * Paulo senior roles, of which the pre-filter correctly discarded 95%. The
 * fix is not a looser filter, it is asking a better question. ADR-011
 * already predicted this: "most of what the pre-filter cuts is geography,
 * and geography is cheaper to filter at the source than after downloading
 * it."
 *
 * Defaulted to a single empty query so a criteria file written before this
 * section existed stays valid and behaves exactly as it did — same
 * discipline as `trackExclusions`, `schedule` and `alerts`.
 */
export const CollectionSchema = z.object({
  queries: z.array(CollectionQuerySchema).min(1),
  /**
   * Pause between consecutive queries in one cycle. The collector's own
   * ~1.5 s interval only applies *between pages of a single query*, so
   * without this a multi-query cycle would fire back-to-back requests at
   * each query boundary — exactly the impolite behaviour CLAUDE.md §6
   * forbids ("a discreet collector is a collector that keeps working").
   */
  queryIntervalMs: z.number().int().nonnegative().default(1_500),
  /**
   * Only keep postings the source published within this many days
   * (ADR-019). Collection runs every few hours, so a one-day window is
   * already generous overlap — anything older has been seen by a previous
   * cycle, or was never going to be seen at all.
   *
   * A posting whose source states no publication date **passes**: absence
   * of a date is not evidence of an old posting, the same leniency ADR-011
   * applies to an unknown `location`/`workMode`.
   */
  recencyDays: z.number().positive().default(1),
  /**
   * The window used when there is no successful `collect` run on record —
   * a first run on an empty database has no previous cycle to have caught
   * the last week, so it reaches back further exactly once.
   */
  backfillDays: z.number().positive().default(7),
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
  collection: CollectionSchema.default({
    queries: [{}],
    queryIntervalMs: 1_500,
    recencyDays: 1,
    backfillDays: 7,
  }),
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
  /**
   * ADR-009's two independent crons, as configuration (docs/09) — a strategy
   * change ("run collection every 2h instead of 4") is a config edit, not a
   * code change. Defaulted to ADR-009's own defaults so an existing criteria
   * file without this section stays valid, same discipline as
   * `trackExclusions`.
   */
  schedule: z
    .object({
      collection: z
        .object({
          intervalHours: z.number().positive().default(4),
        })
        .default({ intervalHours: 4 }),
      scoreAndDeliver: z
        .object({
          // HH:mm, 24h. Validated as a string shape here; the scheduler
          // infrastructure is what turns it into a cron expression.
          time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm, 24h")
            .default("03:00"),
          timezone: z.string().min(1).default("America/Sao_Paulo"),
        })
        .default({ time: "03:00", timezone: "America/Sao_Paulo" }),
    })
    .default({
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    }),
  /**
   * docs/08-observability.md's alert thresholds. `consecutiveEmptyCollectionRuns`
   * is tolerant (collection runs every few hours per `schedule.collection`,
   * so one empty cycle is routine); a missed `scoreAndDeliver` run has no
   * threshold here because it alerts on the first miss, unconditionally —
   * there is no "tolerance" for a day with no digest.
   */
  alerts: z
    .object({
      consecutiveEmptyCollectionRuns: z.number().int().positive().default(2),
      scoreFailureRateThreshold: z.number().min(0).max(1).default(0.5),
    })
    .default({
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
    }),
});

export type Criteria = z.infer<typeof CriteriaSchema>;
export type CollectionQuery = z.infer<typeof CollectionQuerySchema>;
export type LocationCriteria = z.infer<typeof LocationCriteriaSchema>;
export type ScoringConfigCriteria = z.infer<typeof ScoringConfigSchema>;
