import { RawPosting } from "../raw-posting";

export interface CollectionError {
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * A collector never throws — a broken source degrades the pipeline instead of
 * cancelling it (docs/02-architecture.md, principle 1). `error` set is the
 * collector's way of reporting failure; `postings` is **not** guaranteed
 * empty when it is — a collector that pages through a source (Gupy, CIEE,
 * Sólides) fills `postings` with every page that already succeeded before
 * the one that failed, so a later-page failure does not erase earlier valid
 * results (docs/audit/AUDIT_REPORT.md AC-004). Callers must persist
 * `postings` and record the failure, not treat `error` as a signal to
 * discard what is there.
 */
export interface CollectionResult {
  readonly source: string;
  readonly postings: readonly RawPosting[];
  readonly error?: CollectionError;
  readonly collectedAt: Date;
  /**
   * Total raw items the source returned across every page this call
   * fetched, before this collector's own item schema validated any of
   * them — the "received" count a reconciliation needs
   * (docs/audit/AUDIT_REPORT.md AC-012: "collected = schemaRejected +
   * normalized + normalizationRejected" must be checkable). Optional: not
   * every `CollectorPort` implementation can report this cleanly, and an
   * absent count is honestly "unknown," not zero.
   */
  readonly receivedCount?: number;
  /**
   * Of `receivedCount`, how many items failed this collector's own Zod
   * schema and were silently skipped before this call returned — previously
   * discarded with no trace (AC-012). Does not include items a collector
   * rejects for a source-specific business reason after schema validation
   * succeeds (e.g. CIEE's education-level filter) — that is a different,
   * already-controlled kind of drop, not schema drift.
   */
  readonly schemaRejectedCount?: number;
  /**
   * `true` when this call stopped paginating because it hit its own cap
   * (`maxResults`) while the source's last page was still full — meaning
   * more results were plausibly available and never asked for. `false` or
   * absent when the source's own pagination signaled genuine exhaustion
   * (an empty or short final page). A collector finishing "success" with
   * this unset or `false` previously looked identical to one that
   * genuinely reached the end (docs/audit/AUDIT_REPORT.md AC-013).
   */
  readonly truncated?: boolean;
}

export interface CollectorPort {
  collect(criteria: unknown): Promise<CollectionResult>;
}
