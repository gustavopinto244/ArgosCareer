import { createHash } from "node:crypto";
import { Requirement } from "./types";

/**
 * A stable identity for "this exact requirement set", bound into Stage B's
 * cache key (docs/audit AC-007) so a match is only ever reused against the
 * requirements it was actually computed from. `profileHash` and
 * `promptVersion` alone say nothing about whether Stage A's own output
 * changed underneath Stage B — a new Stage A prompt version (`a-v4`
 * splitting one requirement into two, the finding's own example) or a
 * content-hash-triggered re-extraction (ADR-007 Amendment 2) both leave
 * Stage B's old key completely untouched, so the old match kept being
 * served as if it corresponded to the new requirement list.
 *
 * `JSON.stringify` on `Requirement[]` parsed from Zod is deterministic here
 * for the same reason `hashProfile`'s is: schema parsing fixes key order
 * via object literal construction, not a general-purpose stable-stringify.
 */
export function hashRequirements(requirements: readonly Requirement[]): string {
  return createHash("sha256")
    .update(JSON.stringify(requirements))
    .digest("hex");
}
