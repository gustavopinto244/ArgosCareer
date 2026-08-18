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
  readonly tooOldCount?: number;
  readonly unnormalizableCount?: number;
  /** Total raw items collectors reported receiving this run, before their
   * own item schema validated any of them (docs/audit AC-012). `null`
   * (distinct from omitting the field, which leaves the column untouched)
   * means at least one query this run could not report a reconcilable
   * count — a real zero is only ever a query that ran and truly received
   * nothing (docs/audit PR-014). */
  readonly receivedCount?: number | null;
  /** Of `receivedCount`, how many failed a collector's own item schema.
   * Same `null`-means-unreconcilable convention as `receivedCount`. */
  readonly schemaRejectedCount?: number | null;
  readonly failureReason?: string | null;
  /** Serialized to JSON text by `finish` — read back with
   * `parseFailedSources`. */
  readonly failedSources?: readonly string[];
  /** Which source(s) reported `CollectionResult.truncated: true` this run —
   * serialized to JSON text, read back with `parseTruncatedSources`
   * (docs/audit AC-013). */
  readonly truncatedSources?: readonly string[];
  /** Every source at least one query targeted this run, serialized to JSON
   * text, read back with `parseAttemptedSources` (docs/audit PR-003) —
   * distinguishes "this source was queried and failed" from "this source
   * was never queried at all", which `failedSources` alone cannot. */
  readonly attemptedSources?: readonly string[];
  readonly sourceQueryStats?: readonly Readonly<Record<string, unknown>>[];
  /** `scoreAndDeliver` runs only, from `OpenRouterClient.getUsage()` read
   * once after scoring completes — every attempt that reached the network,
   * regardless of outcome (docs/audit AC-015). */
  readonly llmAttempts?: number;
  readonly llmCostUsd?: number;
  /** Of `llmAttempts`, how many never got a usable `usage` block back — a
   * nonzero value here means `llmCostUsd` is a floor, not the real total. */
  readonly llmAttemptsWithoutUsage?: number;
  readonly llmPromptTokens?: number;
  readonly llmCompletionTokens?: number;
  readonly llmCachedPromptTokens?: number;
  readonly llmBlockedByCircuit?: number;
  readonly llmOutcomeCounts?: Readonly<Record<string, number>>;
  readonly llmStageOutcomeCounts?: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  readonly llmProviderCounts?: Readonly<Record<string, number>>;
  readonly llmErrorTypeCounts?: Readonly<Record<string, number>>;
  readonly scoreFailureCounts?: Readonly<Record<string, number>>;
}

/** Both `failedSources` and `truncatedSources` are raw JSON text (schema.ts's
 * note on why: same manual serialize/parse precedent as
 * `requirements`/`matches`). Empty array on null/unparseable rather than a
 * throw — a run row is read far more often than it is written, and a
 * malformed value here must not break `/health` or a summary that reads it. */
function parseStringArrayColumn(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseFailedSources(
  row: Pick<RunRow, "failedSources">,
): string[] {
  return parseStringArrayColumn(row.failedSources);
}

export function parseTruncatedSources(
  row: Pick<RunRow, "truncatedSources">,
): string[] {
  return parseStringArrayColumn(row.truncatedSources);
}

export function parseAttemptedSources(
  row: Pick<RunRow, "attemptedSources">,
): string[] {
  return parseStringArrayColumn(row.attemptedSources);
}

export function parseSourceQueryStats(
  row: Pick<RunRow, "sourceQueryStats">,
): Readonly<Record<string, unknown>>[] {
  if (!row.sourceQueryStats) return [];
  try {
    const parsed: unknown = JSON.parse(row.sourceQueryStats);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is Readonly<Record<string, unknown>> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
  } catch {
    return [];
  }
}

export function parseLlmOutcomeCounts(
  row: Pick<RunRow, "llmOutcomeCounts">,
): Readonly<Record<string, number>> {
  return parseNumericRecordColumn(row.llmOutcomeCounts);
}

function parseNumericRecordColumn(
  value: string | null,
): Readonly<Record<string, number>> {
  if (!value) return {};
  try {
    return parseNumericRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseNumericRecord(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] >= 0,
    ),
  );
}

export function parseLlmProviderCounts(
  row: Pick<RunRow, "llmProviderCounts">,
): Readonly<Record<string, number>> {
  return parseNumericRecordColumn(row.llmProviderCounts);
}

export function parseLlmErrorTypeCounts(
  row: Pick<RunRow, "llmErrorTypeCounts">,
): Readonly<Record<string, number>> {
  return parseNumericRecordColumn(row.llmErrorTypeCounts);
}

export function parseScoreFailureCounts(
  row: Pick<RunRow, "scoreFailureCounts">,
): Readonly<Record<string, number>> {
  return parseNumericRecordColumn(row.scoreFailureCounts);
}

export function parseLlmStageOutcomeCounts(
  row: Pick<RunRow, "llmStageOutcomeCounts">,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  if (!row.llmStageOutcomeCounts) return {};
  try {
    const parsed: unknown = JSON.parse(row.llmStageOutcomeCounts);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([stage, counts]) => [stage, parseNumericRecord(counts)] as const)
        .filter(([, counts]) => Object.keys(counts).length > 0),
    );
  } catch {
    return {};
  }
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

  start(kind: string, startedAt: Date, triggeredBy = "internal"): string {
    const runId = ulid();
    this.db
      .insert(runs)
      .values({ runId, kind, triggeredBy, startedAt, outcome: null })
      .run();
    return runId;
  }

  finish(
    runId: string,
    finishedAt: Date,
    outcome: RunOutcome,
    counts: RunCounts = {},
  ): void {
    const {
      failedSources,
      truncatedSources,
      attemptedSources,
      sourceQueryStats,
      llmOutcomeCounts,
      llmStageOutcomeCounts,
      llmProviderCounts,
      llmErrorTypeCounts,
      scoreFailureCounts,
      ...rest
    } = counts;
    this.db
      .update(runs)
      .set({
        finishedAt,
        outcome,
        ...rest,
        ...(failedSources === undefined
          ? {}
          : { failedSources: JSON.stringify(failedSources) }),
        ...(truncatedSources === undefined
          ? {}
          : { truncatedSources: JSON.stringify(truncatedSources) }),
        ...(attemptedSources === undefined
          ? {}
          : { attemptedSources: JSON.stringify(attemptedSources) }),
        ...(sourceQueryStats === undefined
          ? {}
          : { sourceQueryStats: JSON.stringify(sourceQueryStats) }),
        ...(llmOutcomeCounts === undefined
          ? {}
          : { llmOutcomeCounts: JSON.stringify(llmOutcomeCounts) }),
        ...(llmStageOutcomeCounts === undefined
          ? {}
          : { llmStageOutcomeCounts: JSON.stringify(llmStageOutcomeCounts) }),
        ...(llmProviderCounts === undefined
          ? {}
          : { llmProviderCounts: JSON.stringify(llmProviderCounts) }),
        ...(llmErrorTypeCounts === undefined
          ? {}
          : { llmErrorTypeCounts: JSON.stringify(llmErrorTypeCounts) }),
        ...(scoreFailureCounts === undefined
          ? {}
          : { scoreFailureCounts: JSON.stringify(scoreFailureCounts) }),
      })
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

  /**
   * The `limit` most recent runs of `kind`, newest first — M9's
   * `GET /runs?kind=&limit=` inspection endpoint. `findRunsSince` returns
   * every match unordered, which is right for the deliver command's
   * "everything since last digest" window but wrong for "show me the last
   * few runs", so this is a distinct query rather than a sort-and-slice
   * wrapper around it.
   */
  findRecent(kind: string, limit: number): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.kind, kind))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .all();
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

  /**
   * The most recent `collect` run in which `source` was attempted and did
   * not fail — independent of that run's own aggregate `outcome` (docs/audit
   * PR-003). A mixed run is marked "success" the moment not every query
   * failed (`executeCollect`'s `allFailed`), so one healthy source is
   * already enough to make the whole run look fine while a different
   * source has been failing for days — `findLatestFinished("collect",
   * "success")` cannot tell those two situations apart. Scanning
   * `attemptedSources`/`failedSources` membership directly, per source,
   * recovers the distinction: this returns null only when `source` has
   * never once succeeded, not merely when the *run* it last succeeded in
   * also happened to be reported as an overall failure.
   *
   * Reads every `collect` run rather than a bounded window — this
   * project's scale (a personal batch job, not a fleet) makes an unbounded
   * scan the same non-issue `findRunsSince(kind, null)` already treats it
   * as elsewhere in this class.
   */
  findLastSuccessfulSourceCollectAt(source: string): Date | null {
    const rows = this.db
      .select()
      .from(runs)
      .where(eq(runs.kind, "collect"))
      .orderBy(desc(runs.finishedAt))
      .all();
    for (const row of rows) {
      if (row.finishedAt === null) continue;
      if (
        parseAttemptedSources(row).includes(source) &&
        !parseFailedSources(row).includes(source)
      ) {
        return row.finishedAt;
      }
    }
    return null;
  }
}
