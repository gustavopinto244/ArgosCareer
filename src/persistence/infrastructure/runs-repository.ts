import { and, desc, eq, gte } from "drizzle-orm";
import { ulid } from "ulid";
import { Db } from "./db";
import { runs } from "./schema";

export type RunOutcome = "success" | "failed";
export type RunRow = typeof runs.$inferSelect;

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

  /**
   * Runs of `kind` started at or after `since`, or every run of that kind
   * when `since` is null — the deliver command's window for "what happened
   * since the last digest" (M6).
   */
  findRunsSince(kind: string, since: Date | null): RunRow[] {
    const condition =
      since === null
        ? eq(runs.kind, kind)
        : and(eq(runs.kind, kind), gte(runs.startedAt, since));
    return this.db.select().from(runs).where(condition).all();
  }

  /** Most recent finished run of `kind` with the given outcome, or null if
   * none exists yet — used to find the last successful delivery. */
  findLatestFinished(kind: string, outcome: RunOutcome): RunRow | null {
    const rows = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.kind, kind), eq(runs.outcome, outcome)))
      .orderBy(desc(runs.finishedAt))
      .limit(1)
      .all();
    return rows[0] ?? null;
  }
}
