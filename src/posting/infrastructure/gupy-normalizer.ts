import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting, WorkMode } from "../domain/posting";
import { GupyJob, GupyJobSchema } from "./gupy-schema";

function mapWorkMode(workplaceType: string | undefined): WorkMode {
  switch (workplaceType) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "on-site":
      return "onsite";
    default:
      return "unknown";
  }
}

function mapLocation(job: GupyJob): Location {
  return job.city ? { kind: "known", city: job.city } : { kind: "unknown" };
}

/**
 * Null on anything unparseable, not a thrown error — an unexpected deadline
 * format must not fail normalization over one optional field. The pre-filter
 * treats a null deadline as unknown, not automatically expired or current
 * (M5).
 */
function mapApplicationDeadline(job: GupyJob): Date | null {
  if (!job.applicationDeadline) return null;
  const parsed = new Date(job.applicationDeadline);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for Gupy specifically. `firstSeenAt` and
 * `lastSeenAt` are both set to `now` here — this is a fresh, not-yet-persisted
 * observation; deciding whether an existing row's `firstSeenAt` survives is
 * the postings repository's job (ADR-007 amendment), not Normalize's.
 *
 * Returns `null` rather than throwing when the payload cannot become a valid
 * `Posting` — missing `careerPageName`, or an invariant `createPosting`
 * enforces. Rare (every item observed in `test/fixtures/gupy-jobs.md` had
 * one), but principle 1 applies to Normalize too: one bad item must not take
 * the batch down.
 */
export function normalizeGupyJob(raw: RawPosting, now: Date): Posting | null {
  const parsed = GupyJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job = parsed.data;
  if (!job.careerPageName) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.careerPageName,
      title: job.name,
      location: mapLocation(job),
      workMode: mapWorkMode(job.workplaceType),
      applicationDeadline: mapApplicationDeadline(job),
      sourceUrl: job.jobUrl ?? null,
      description: job.description ?? null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}
