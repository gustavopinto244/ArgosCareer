import { createHash } from "node:crypto";
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
 */
export function hashProfile(profile: Profile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
