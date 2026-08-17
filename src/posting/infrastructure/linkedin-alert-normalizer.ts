import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting, WorkMode } from "../domain/posting";
import {
  LinkedinAlertJob,
  LinkedinAlertJobSchema,
} from "./linkedin-alert-schema";

/**
 * `location` arrives as one string — `"Rio de Janeiro, RJ (Híbrido)"` or
 * `"Brasil (Remoto)"` — with the work mode bundled inside a trailing
 * parenthetical. Splitting them is the whole point of this normalizer
 * (ADR-029): once separated, the existing pre-filter (`isLocationAllowed`,
 * ADR-011 Amendment 3) already rejects a hybrid posting outside the target
 * cities and passes any remote one, with no new pre-filter code — that
 * asymmetric leniency rule was built for Gupy/CIEE and applies unchanged
 * here.
 *
 * `"Brasil"` (country-level, no real city — every fully-remote alert
 * observed uses this) maps to `location: unknown`, not a literal city
 * named "Brasil". A city is only ever the text before the first comma in
 * a `"Cidade, UF"` pair — the state abbreviation is discarded, matching
 * every other source's city-only granularity.
 */
function parseLocationAndWorkMode(raw: string | null | undefined): {
  location: Location;
  workMode: WorkMode;
} {
  const unknown = {
    location: { kind: "unknown" } as Location,
    workMode: "unknown" as WorkMode,
  };
  if (!raw) return unknown;

  const match = /^(.*)\(([^)]+)\)\s*$/.exec(raw);
  if (!match) return unknown;

  const [, place, modeLabel] = match;
  const workMode = mapWorkModeLabel(modeLabel?.trim() ?? "");
  const placeTrimmed = place?.trim() ?? "";

  if (!placeTrimmed || placeTrimmed.toLowerCase() === "brasil") {
    return { location: { kind: "unknown" }, workMode };
  }
  const city = placeTrimmed.split(",")[0]?.trim();
  return {
    location: city ? { kind: "known", city } : { kind: "unknown" },
    workMode,
  };
}

function mapWorkModeLabel(label: string): WorkMode {
  const normalized = label.toLowerCase();
  if (normalized.includes("remoto")) return "remote";
  if (normalized.includes("híbrido") || normalized.includes("hibrido")) {
    return "hybrid";
  }
  if (normalized.includes("presencial")) return "onsite";
  return "unknown";
}

/**
 * `RawPosting` → `Posting`, for LinkedIn job-alert emails (ADR-029).
 * `sourceId` is trusted from the envelope, same as every other source — the
 * caller (n8n) extracts the numeric id from the `link`'s
 * `/jobs/view/<id>/` path before POSTing, this normalizer does not
 * re-derive it.
 *
 * `publishedAt` is always null. LinkedIn's alert email states no
 * publication date, only when the alert was sent — which is not the same
 * fact, and CLAUDE.md §15 forbids treating one as the other. This is
 * CIEE's exact situation (`docs/11-known-issues.md` B1): `firstSeenAt`
 * (set by the caller of this normalizer, not read from the payload) is
 * what `maxAgeDays` falls back to.
 *
 * `description` is always null — LinkedIn's alert email states no job
 * description, only title/company/location. Stage A already treats a null
 * description as "nothing to extract" at zero LLM cost
 * (`stage-a-extractor.ts`), and the resulting empty requirement list trips
 * `lowConfidence`, capping the verdict at `review` — the existing safety
 * net (`docs/04-scoring-model.md`) built for a different trigger, applying
 * here without any new code.
 */
export function normalizeLinkedinAlertJob(
  raw: RawPosting,
  now: Date,
): Posting | null {
  const parsed = LinkedinAlertJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job: LinkedinAlertJob = parsed.data;
  const { location, workMode } = parseLocationAndWorkMode(job.location);

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.company,
      title: job.title,
      location,
      workMode,
      applicationDeadline: null,
      publishedAt: null,
      sourceUrl: job.link ?? null,
      description: null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}
