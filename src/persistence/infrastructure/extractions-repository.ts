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

/** `null` on anything that does not parse as an array — a corrupted or
 * truncated cache row (docs/audit AC-031: a restore or manual edit is the
 * realistic cause, since this table is otherwise only ever written by
 * `upsert` with `JSON.stringify`'s own output) must read back as a cache
 * miss, not throw and take down whatever read it (`find`'s single caller in
 * `ApiScorer`, or M10's corpus-wide `findAllForPromptVersion` scan). A
 * missed cache entry costs one re-run of Stage A; an uncaught throw here
 * would cost the entire batch, the opposite of principle 1. */
function parseRequirements(value: string): Requirement[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Requirement[]) : null;
  } catch {
    return null;
  }
}

/**
 * Stage A's cache, keyed `(fingerprint, promptVersion)` (ADR-007) *and*
 * `contentHash` (docs/audit AC-006) *and* `model` (docs/audit AC-007) — the
 * row is stored under the first pair (one current extraction per
 * posting/prompt-version, same as before), but `find` only returns it as a
 * hit when the stored `contentHash`/`model` both match the current call. A
 * posting's `fingerprint` does not change when its description is edited
 * (ADR-007: company+title+city only), so without `contentHash` a
 * re-collected posting with new text kept serving the extraction of the
 * old text forever; without `model`, switching `LLM_MODEL` silently reused
 * a different model's extraction as if it were the current one's. Upsert
 * rather than insert, matching every other stage's write rule: writing the
 * same extraction twice is indistinguishable from writing it once, so a
 * re-run after a crash costs nothing extra.
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
        ),
      )
      .get();

    if (!row) return null;
    // A legacy row (written before these columns existed), one whose
    // content has since changed (AC-006), or one produced by a different
    // model (AC-007) is a miss, not a stale hit.
    if (row.contentHash !== contentHash) return null;
    if (row.model !== model) return null;

    const requirements = parseRequirements(row.requirements);
    if (!requirements) return null;

    return {
      requirements,
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

    // A corrupted row is skipped, not fatal to the whole scan (same
    // reasoning as `find` above) — M10's aggregate reads one fewer
    // extraction rather than none at all.
    const result: FingerprintedExtraction[] = [];
    for (const row of rows) {
      const requirements = parseRequirements(row.requirements);
      if (!requirements) continue;
      result.push({
        fingerprint: row.fingerprint,
        requirements,
        seniority: row.seniority as Seniority | null,
        experienceYears: row.experienceYears,
      });
    }
    return result;
  }
}
