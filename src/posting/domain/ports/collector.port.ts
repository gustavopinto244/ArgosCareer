import { RawPosting } from "../raw-posting";

export interface CollectionError {
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * A collector never throws — a broken source degrades the pipeline instead of
 * cancelling it (docs/02-architecture.md, principle 1). `error` set and
 * `postings` empty is the collector's way of reporting failure.
 */
export interface CollectionResult {
  readonly source: string;
  readonly postings: readonly RawPosting[];
  readonly error?: CollectionError;
  readonly collectedAt: Date;
}

export interface CollectorPort {
  collect(criteria: unknown): Promise<CollectionResult>;
}
