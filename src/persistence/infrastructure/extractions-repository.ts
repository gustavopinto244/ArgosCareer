import { and, eq } from "drizzle-orm";
import { Seniority } from "../../posting/domain/posting";
import { Requirement } from "../../scoring/domain/types";
import { Db } from "./db";
import { extractions } from "./schema";

export interface ExtractionRecord {
  readonly requirements: readonly Requirement[];
  readonly seniority: Seniority | null;
  readonly experienceYears: number | null;
}

export interface FingerprintedExtraction extends ExtractionRecord {
  readonly fingerprint: string;
}

/**
 * Stage A's cache, keyed `(fingerprint, promptVersion)` (ADR-007). Upsert
 * rather than insert, matching every other stage's write rule: writing the
 * same extraction twice is indistinguishable from writing it once, so a
 * re-run after a crash costs nothing extra.
 */
export class ExtractionsRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    promptVersion: string,
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
        ),
      )
      .get();

    const values = {
      requirements: JSON.stringify(record.requirements),
      seniority: record.seniority,
      experienceYears: record.experienceYears,
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

  find(fingerprint: string, promptVersion: string): ExtractionRecord | null {
    const row = this.db
      .select()
      .from(extractions)
      .where(
        and(
          eq(extractions.fingerprint, fingerprint),
          eq(extractions.promptVersion, promptVersion),
        ),
      )
      .get();

    if (!row) return null;

    return {
      requirements: JSON.parse(row.requirements) as Requirement[],
      seniority: row.seniority as Seniority | null,
      experienceYears: row.experienceYears,
    };
  }

  /**
   * Every cached extraction for the current prompt version — M10's
   * substrate for retrospective aggregation over the corpus, without
   * re-running Stage A (ADR-007). Scoped to one `promptVersion` rather than
   * every row ever written: an extraction under a superseded prompt is not
   * "more data," it is a stale answer to a question the current prompt asks
   * differently.
   */
  findAllForPromptVersion(promptVersion: string): FingerprintedExtraction[] {
    const rows = this.db
      .select()
      .from(extractions)
      .where(eq(extractions.promptVersion, promptVersion))
      .all();

    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      requirements: JSON.parse(row.requirements) as Requirement[],
      seniority: row.seniority as Seniority | null,
      experienceYears: row.experienceYears,
    }));
  }
}
