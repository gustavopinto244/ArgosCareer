import { createHash } from "node:crypto";
import { Criteria } from "./criteria";

/**
 * A stable identity for "this exact criteria", mirroring `hashProfile`
 * (`src/profile/domain/profile-hash.ts`) — same reasoning, same limitation
 * (`JSON.stringify` is deterministic here only because `CriteriaSchema.parse`
 * fixes key order via object literal construction, not a general-purpose
 * stable-stringify).
 *
 * Used to tag every `posting_events` "prefilter" row with which criteria
 * version produced it (docs/audit/AUDIT_REPORT.md AC-019), so a later
 * criteria change is visible as a new decision rather than silently
 * overwriting or contradicting the old one.
 */
export function hashCriteria(criteria: Criteria): string {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}
