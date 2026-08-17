import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting, WorkMode } from "../domain/posting";
import { SolidesJob, SolidesJobSchema } from "./solides-schema";

/**
 * `homeOffice` is the signal trusted here, not `jobType` — see
 * `solides-schema.ts`'s note on why `jobType` stays an open string. Only
 * `homeOffice: true` → `"remote"` and `jobType === "presencial"` → `"onsite"`
 * are asserted because only those two states were ever observed; anything
 * else (including a future `"hibrido"`/`"remoto"` `jobType` value) maps to
 * `"unknown"` rather than a guessed enum.
 */
function mapWorkMode(job: SolidesJob): WorkMode {
  if (job.homeOffice === true) return "remote";
  if (job.jobType === "presencial") return "onsite";
  return "unknown";
}

function mapLocation(job: SolidesJob): Location {
  return job.city?.name
    ? { kind: "known", city: job.city.name }
    : { kind: "unknown" };
}

/**
 * Sólides states `createdAt` as a bare date (`"2026-08-15"`, no time), on
 * every item observed during discovery. Null on anything unparseable — same
 * tolerance as Gupy's `publishedDate` mapping — the recency window treats
 * null as "unknown, keep".
 */
function mapPublishedAt(job: SolidesJob): Date | null {
  if (!job.createdAt) return null;
  const parsed = new Date(job.createdAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for Sólides specifically. `firstSeenAt` and
 * `lastSeenAt` are both set to `now` here — this is a fresh, not-yet-persisted
 * observation; deciding whether an existing row's `firstSeenAt` survives is
 * the postings repository's job (ADR-007 amendment), not Normalize's.
 *
 * Returns `null` rather than throwing when the payload cannot become a valid
 * `Posting` — missing `companyName`, or an invariant `createPosting` enforces.
 * Every item observed in discovery had one, but principle 1 applies to
 * Normalize too: one bad item must not take the batch down.
 */
export function normalizeSolidesJob(
  raw: RawPosting,
  now: Date,
): Posting | null {
  const parsed = SolidesJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job = parsed.data;
  if (!job.companyName) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.companyName,
      title: job.title,
      location: mapLocation(job),
      workMode: mapWorkMode(job),
      applicationDeadline: null,
      publishedAt: mapPublishedAt(job),
      sourceUrl: job.redirectLink ?? null,
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
