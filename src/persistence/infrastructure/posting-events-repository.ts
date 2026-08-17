import { desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { Db } from "./db";
import { postingEvents } from "./schema";

export type PostingEventRow = typeof postingEvents.$inferSelect;

export interface PostingEventInput {
  readonly runId: string;
  readonly fingerprint?: string | null;
  readonly source?: string | null;
  readonly sourceId?: string | null;
  readonly stage: string;
  readonly outcome: string;
  readonly reason?: string | null;
  readonly criteriaHash?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly occurredAt: Date;
}

export function parsePostingEventMetadata(
  row: Pick<PostingEventRow, "metadata">,
): Readonly<Record<string, unknown>> | null {
  if (!row.metadata) return null;
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Append-only per-(run, posting, stage) decision log (docs/audit
 * AC-019/AC-027). No `update`/`delete` method exists on purpose — a wrong
 * decision is corrected by a later row from a later run, never by editing
 * history.
 */
export class PostingEventsRepository {
  constructor(private readonly db: Db) {}

  record(event: PostingEventInput): void {
    this.db
      .insert(postingEvents)
      .values({
        id: ulid(),
        runId: event.runId,
        fingerprint: event.fingerprint ?? null,
        source: event.source ?? null,
        sourceId: event.sourceId ?? null,
        stage: event.stage,
        outcome: event.outcome,
        reason: event.reason ?? null,
        criteriaHash: event.criteriaHash ?? null,
        metadata:
          event.metadata === undefined || event.metadata === null
            ? null
            : JSON.stringify(event.metadata),
        occurredAt: event.occurredAt,
      })
      .run();
  }

  /** Every event this run produced, in whatever order SQLite returns them —
   * callers that need chronological order sort on `occurredAt` themselves. */
  findByRun(runId: string): PostingEventRow[] {
    return this.db
      .select()
      .from(postingEvents)
      .where(eq(postingEvents.runId, runId))
      .all();
  }

  /** A posting's full decision history across every run, most recent
   * first — "why is this posting where it is" answered without touching
   * `postings` itself. */
  findByFingerprint(fingerprint: string): PostingEventRow[] {
    return this.db
      .select()
      .from(postingEvents)
      .where(eq(postingEvents.fingerprint, fingerprint))
      .orderBy(desc(postingEvents.occurredAt))
      .all();
  }
}
