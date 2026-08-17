import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Seniority } from "../../posting/domain/posting";
import { Requirement, RequirementSchema } from "../../scoring/domain/types";
import { Db } from "./db";
import { extractions } from "./schema";

export interface ExtractionRecord {
  readonly requirements: readonly Requirement[];
  readonly seniority: Seniority | null;
  readonly experienceYears: number | null;
}

const CachedRequirementsSchema = z.array(RequirementSchema);

/** `null` on anything that is not a valid `Requirement[]` — a corrupted or
 * truncated cache row (docs/audit AC-031), or one that parses as JSON and is
 * even an array but whose elements are not real `Requirement`s (docs/audit
 * PR-013 — `[{}]`, `[null]`, an invalid `weight` enum, a mismatched nested
 * shape: all valid JSON, none of them a `Requirement`). Either way this must
 * read back as a cache miss, not throw and take down whatever read it —
 * `find`'s only caller (`StageAExtractor`, and `MarketRepository`, which
 * reads this cache one posting at a time through the same method rather
 * than a separate bulk scan, docs/audit PR-017). A missed cache entry costs
 * one re-run of Stage A; an uncaught throw here would cost the entire
 * batch, the opposite of principle 1. */
function parseRequirements(value: string): Requirement[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = CachedRequirementsSchema.safeParse(parsed);
  return result.success ? (result.data as Requirement[]) : null;
}

/**
 * Stage A's cache, keyed by the composite `(fingerprint, promptVersion,
 * model, contentHash)` (ADR-007, docs/audit AC-006/AC-007/PR-017). Before
 * PR-017, the row actually stored/looked-up was keyed only on
 * `(fingerprint, promptVersion)` — `contentHash`/`model` were checked only
 * *after* a row was already found, so a different model or edited-then-
 * reverted content did not get its own coexisting row: `upsert` overwrote
 * whatever was there, even though `find` already correctly refused to
 * treat it as a hit. Switching `LLM_MODEL` back and forth (a real M7
 * calibration pattern) evicted a still-valid extraction and paid for it
 * again on the way back. Making all four fields the row's actual identity
 * — enforced by `extractions_composite_identity_unique` — is what makes
 * "coexist under its declared key" true at the database level, not only in
 * `find`'s post-read check.
 */
export class ExtractionsRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    promptVersion: string,
    model: string,
    contentHash: string,
    record: ExtractionRecord,
    extractedAt: Date,
  ): void {
    const existing = this.db
      .select()
      .from(extractions)
      .where(
        and(
          eq(extractions.fingerprint, fingerprint),
          eq(extractions.promptVersion, promptVersion),
          eq(extractions.model, model),
          eq(extractions.contentHash, contentHash),
        ),
      )
      .get();

    const values = {
      requirements: JSON.stringify(record.requirements),
      seniority: record.seniority,
      experienceYears: record.experienceYears,
      contentHash,
      model,
      extractedAt,
    };

    if (existing) {
      this.db
        .update(extractions)
        .set(values)
        .where(eq(extractions.id, existing.id))
        .run();
    } else {
      this.db
        .insert(extractions)
        .values({ fingerprint, promptVersion, ...values })
        .run();
    }
  }

  find(
    fingerprint: string,
    promptVersion: string,
    model: string,
    contentHash: string,
  ): ExtractionRecord | null {
    const row = this.db
      .select()
      .from(extractions)
      .where(
        and(
          eq(extractions.fingerprint, fingerprint),
          eq(extractions.promptVersion, promptVersion),
          eq(extractions.model, model),
          eq(extractions.contentHash, contentHash),
        ),
      )
      .get();
    if (!row) return null;

    const requirements = parseRequirements(row.requirements);
    if (!requirements) return null;

    return {
      requirements,
      seniority: row.seniority as Seniority | null,
      experienceYears: row.experienceYears,
    };
  }
}
