import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { GupyJobSchema, GupyResponseEnvelopeSchema } from "./gupy-schema";

const SOURCE = "gupy";
const ENDPOINT = "https://employability-portal.gupy.io/api/v1/jobs";

/**
 * Identifies what this is, honestly — never forged to imitate a browser
 * (CLAUDE.md §6, docs/02-architecture.md collector etiquette).
 */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];

const GupyCollectorCriteriaSchema = z.object({
  jobName: z.string().optional(),
  city: z.string().optional(),
  type: z.string().optional(),
  isRemoteWork: z.boolean().optional(),
  pageSize: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
});

export type GupyCollectorCriteria = z.infer<typeof GupyCollectorCriteriaSchema>;

type FetchLike = typeof fetch;

export interface GupyCollectorOptions {
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  requestIntervalMs?: number;
  backoffDelaysMs?: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  criteria: GupyCollectorCriteria,
  offset: number,
  limit: number,
): string {
  const url = new URL(ENDPOINT);
  if (criteria.jobName) url.searchParams.set("jobName", criteria.jobName);
  if (criteria.city) url.searchParams.set("city", criteria.city);
  if (criteria.type) url.searchParams.set("type", criteria.type);
  if (criteria.isRemoteWork !== undefined) {
    url.searchParams.set("isRemoteWork", String(criteria.isRemoteWork));
  }
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

/**
 * `GupyCollector` never throws — every failure path returns a
 * `CollectionResult` with `error` set and `postings` empty, matching
 * `CollectorPort`'s contract (docs/05-domain-model.md, principle 1). A
 * single malformed item within an otherwise-successful page is the one
 * exception: it is skipped, not treated as a collection failure, because
 * `GupyJobSchema` is deliberately tolerant and only a pathological item
 * would fail it.
 */
export class GupyCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];

  constructor(options: GupyCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();

    const criteriaResult = GupyCollectorCriteriaSchema.safeParse(
      rawCriteria ?? {},
    );
    if (!criteriaResult.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid Gupy collection criteria",
          cause: criteriaResult.error,
        },
      };
    }
    const criteria = criteriaResult.data;
    const pageSize = criteria.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;

    const postings: RawPosting[] = [];
    let offset = 0;
    let receivedCount = 0;
    let schemaRejectedCount = 0;
    let truncated = false;

    try {
      // Bounds the number of raw items scanned, not the number of valid
      // postings collected. Bounding on valid count instead would make the
      // collector page more aggressively whenever validation starts
      // failing — the opposite of what a degrading source should trigger.
      while (offset < maxResults) {
        if (offset > 0) await sleep(this.requestIntervalMs);

        const limit = Math.min(pageSize, maxResults - offset);
        const url = buildUrl(criteria, offset, limit);
        const response = await this.fetchWithBackoff(url);

        if (!response.ok) {
          return {
            source: SOURCE,
            postings: [],
            collectedAt,
            error: {
              message: `Gupy responded ${response.status} ${response.statusText}`,
            },
          };
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch (cause) {
          return {
            source: SOURCE,
            postings: [],
            collectedAt,
            error: { message: "Malformed Gupy response body", cause },
          };
        }

        const envelope = GupyResponseEnvelopeSchema.safeParse(body);
        if (!envelope.success) {
          return {
            source: SOURCE,
            postings: [],
            collectedAt,
            error: {
              message: "Unexpected Gupy response shape",
              cause: envelope.error,
            },
          };
        }

        const items = envelope.data.data;
        if (items.length === 0) break;
        receivedCount += items.length;

        for (const item of items) {
          const parsed = GupyJobSchema.safeParse(item);
          if (parsed.success) {
            postings.push({
              source: SOURCE,
              sourceId: String(parsed.data.id),
              payload: parsed.data,
            });
          } else {
            schemaRejectedCount += 1;
          }
        }

        offset += items.length;
        if (items.length < limit) break;
        // A full page, but the next iteration won't run (offset now at or
        // past the cap) — the source's last observed page was not short,
        // so more results were plausibly there and never asked for.
        if (offset >= maxResults) truncated = true;
      }
    } catch (cause) {
      // Reached once fetchWithBackoff exhausts every attempt (a persistent
      // 5xx or network failure) — the underlying message is folded in so a
      // final "responded 500" or "fetch failed" isn't reduced to a generic
      // "request failed" with the detail buried only in `cause`.
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: { message: `Gupy request failed: ${detail}`, cause },
      };
    }

    return {
      source: SOURCE,
      postings,
      collectedAt,
      receivedCount,
      schemaRejectedCount,
      truncated,
    };
  }

  /**
   * Explicit timeout per request via AbortController, exponential backoff
   * across attempts. Only 5xx and network-level failures are retried — a 4xx
   * means the request itself is wrong, and retrying it wastes the source's
   * time for no different outcome (collector etiquette, CLAUDE.md §6).
   */
  private async fetchWithBackoff(url: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.backoffDelaysMs.length; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        if (response.ok || response.status < 500) return response;
        lastError = new Error(`Gupy responded ${response.status}`);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      const delay = this.backoffDelaysMs[attempt];
      if (delay !== undefined) await sleep(delay);
    }

    throw lastError;
  }
}
