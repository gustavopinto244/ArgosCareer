import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { Db } from "./db";
import { runs } from "./schema";

export type RunOutcome = "success" | "failed";

export interface RunCounts {
  readonly collectedCount?: number;
  readonly normalizedCount?: number;
  readonly newCount?: number;
  readonly alreadySeenCount?: number;
  readonly duplicateCount?: number;
  readonly filteredCount?: number;
  readonly scoredCount?: number;
  readonly deliveredCount?: number;
}

/**
 * One row per pipeline execution (docs/08-observability.md), the audit trail
 * behind principle 2 — "what did Tuesday's run actually do?" `kind` is
 * whatever CLI stage produced it ("collect", "dedup"); not a fixed enum,
 * because the set of stages grows every milestone and SQLite has no real
 * enum to constrain it against anyway.
 */
export class RunsRepository {
  constructor(private readonly db: Db) {}

  start(kind: string, startedAt: Date): string {
    const runId = ulid();
    this.db
      .insert(runs)
      .values({ runId, kind, startedAt, outcome: null })
      .run();
    return runId;
  }

  finish(
    runId: string,
    finishedAt: Date,
    outcome: RunOutcome,
    counts: RunCounts = {},
  ): void {
    this.db
      .update(runs)
      .set({ finishedAt, outcome, ...counts })
      .where(eq(runs.runId, runId))
      .run();
  }

  findById(runId: string) {
    return this.db.select().from(runs).where(eq(runs.runId, runId)).get();
  }
}
