import { createHash } from "node:crypto";
import { computeAcademicPeriod } from "./academic-period";
import { Profile } from "./profile";

/**
 * A stable identity for "this exact profile", used to key the stage B match
 * cache (ADR-007: `(fingerprint, profileHash, promptVersion)`) so editing the
 * profile invalidates cached matches rather than silently reusing stale
 * ones. No cache exists yet — that lands with stage B in M7 — but
 * `ScorerPort.score` already takes a `profileHash` argument, and this is
 * what produces it.
 *
 * `JSON.stringify` on a plain object from `ProfileSchema.parse` is
 * deterministic here because the schema fixes key order via object literal
 * construction; this is not a general-purpose stable-stringify.
 *
 * `today` folds in the derived academic period (docs/audit AC-018):
 * `formatAcademicEvidence` (`scoring/infrastructure/prompts.ts`) renders
 * "cursando o Nº período" as quotable Stage B evidence, computed from
 * `profile.courseStart` and the current date — a fact this hash previously
 * had no way to see, since it only ever serialized the profile object
 * itself. A cached match written the day before a semester boundary kept
 * answering with the old period indefinitely, because nothing about the
 * profile *object* changed at the boundary, only what the rendered
 * evidence said. Hashing `computeAcademicPeriod`'s result (not `today`
 * itself) means the hash changes twice a year, at the actual boundary,
 * rather than once a day — a raw date would defeat caching entirely.
 * Defaulted to `new Date()`, not required, so the (few) tests and scripts
 * that never cared about this axis keep working unchanged.
 */
export function hashProfile(
  profile: Profile,
  today: Date = new Date(),
): string {
  const academicPeriod = computeAcademicPeriod(profile.courseStart, today);
  const payload = { profile, academicPeriod };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
