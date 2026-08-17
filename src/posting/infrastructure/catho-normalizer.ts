import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting, WorkMode } from "../domain/posting";
import {
  CathoPostingEnvelope,
  CathoPostingEnvelopeSchema,
} from "./catho-schema";

/**
 * The city comes from the page `<title>`, not the JSON-LD's
 * `jobLocation[].address.addressLocality` — see `catho-schema.ts`'s note on
 * why that field is not trusted. Real observed format:
 * `"Vaga de Emprego de {title}, {city} /"`. Returns `unknown` on anything
 * that does not match, rather than guessing — only 2 real samples confirmed
 * this pattern, and a third page shaped differently is more likely than a
 * guessed regex being universally correct.
 */
const TITLE_CITY_PATTERN = /^Vaga de Emprego de .+, ([^,/]+?)\s*\/\s*$/;

function mapLocation(pageTitle: string | undefined): Location {
  if (!pageTitle) return { kind: "unknown" };
  const match = TITLE_CITY_PATTERN.exec(pageTitle);
  const city = match?.[1]?.trim();
  return city ? { kind: "known", city } : { kind: "unknown" };
}

/**
 * No remote/telecommute signal was ever observed in the 2 real samples this
 * schema was fitted against — schema.org's `jobLocationType: "TELECOMMUTE"`
 * is the field that would carry it, checked for tolerantly here even though
 * never seen, same discipline as `mapWorkMode` elsewhere in this project:
 * map what has been confirmed, `unknown` for everything else, never a guess.
 */
function mapWorkMode(job: CathoPostingEnvelope["jobPosting"]): WorkMode {
  const raw = job as { jobLocationType?: unknown };
  return raw.jobLocationType === "TELECOMMUTE" ? "remote" : "unknown";
}

/**
 * `datePosted` agreed with the "Vaga Incluída em DD-MM-YYYY" text
 * independently visible in the page's meta description on both real
 * samples — unlike `addressLocality`, nothing contradicted it, so it is
 * trusted here. Null on anything unparseable, same tolerance every other
 * normalizer in this project uses.
 */
function mapPublishedAt(datePosted: string | undefined): Date | null {
  if (!datePosted) return null;
  const parsed = new Date(datePosted);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for Catho specifically. The raw payload arrives
 * already-fetched, via the ingest endpoint (ADR-027's pattern, reused here)
 * — this normalizer makes no network call itself, same as
 * `normalizeIndeedJob`/`normalizeLinkedinAlertJob`.
 *
 * Returns `null` rather than throwing when the payload cannot become a valid
 * `Posting` — missing `hiringOrganization.name`, or an invariant
 * `createPosting` enforces. Principle 1 applies to Normalize too: one bad
 * item must not take the batch down.
 */
export function normalizeCathoJob(raw: RawPosting, now: Date): Posting | null {
  const parsed = CathoPostingEnvelopeSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const envelope = parsed.data;
  const job = envelope.jobPosting;
  const company = job.hiringOrganization?.name;
  if (!company) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company,
      title: job.title,
      location: mapLocation(envelope.pageTitle),
      workMode: mapWorkMode(job),
      applicationDeadline: null,
      publishedAt: mapPublishedAt(job.datePosted),
      sourceUrl: envelope.url ?? null,
      description: job.description ?? null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: envelope,
    });
  } catch {
    return null;
  }
}
