import { createHash } from "node:crypto";

/**
 * A stable identity for "this exact content sent to Stage A" — `title` and
 * `description` are the only content-bearing inputs `buildStageAPrompt`
 * uses (`scoring/infrastructure/prompts.ts`). Bound into the extraction
 * cache key (docs/audit AC-006) so a posting whose description changes
 * after first collection gets a fresh extraction instead of silently
 * keeping the answer to a description that no longer exists.
 *
 * `fingerprint` (ADR-007: company+title+city only) does not change when a
 * company edits a posting's description — by design, that is still the
 * same real opening — but Stage A's cache previously keyed only on
 * `(fingerprint, promptVersion)`, so it had no way to notice the content
 * itself had moved out from under it.
 *
 * A null byte (never legitimately present in posting text) separates the
 * two fields so `("A", "BC")` and `("AB", "C")` cannot collide — an
 * ordinary space would not be safe, since both fields can themselves
 * contain spaces at the boundary.
 */
export function hashExtractionInput(
  title: string,
  description: string | null,
): string {
  return createHash("sha256")
    .update(title)
    .update("\0")
    .update(description ?? "")
    .digest("hex");
}
