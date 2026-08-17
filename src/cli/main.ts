#!/usr/bin/env node
/**
 * Each pipeline stage invocable independently, the actual test of principle 2
 * (docs/02-architecture.md) for this milestone: `dedup` re-scans the corpus
 * for near-duplicates without touching a collector or the network at all.
 *
 *   argos collect [--job-name <text>] [--city <text>] [--max-results <n>]
 *                 [--since-days <n>]  # one-off wider window, e.g. after
 *                                     # adding a query term (ADR-019)
 *   argos dedup [--similarity-threshold <0-1>] [--window-days <n>] [--reset]
 *   argos deliver
 *   argos studyplan
 *   argos discard <fingerprint> [--reason <text>]
 */
import { parseArgs } from "node:util";
import { CollectorPort } from "../posting/domain/ports/collector.port";
import { collectorFor } from "../posting/infrastructure/collector-registry";
import {
  Normalizer,
  normalizerFor,
} from "../posting/infrastructure/normalizer-registry";
import {
  DEFAULT_DEDUP_CONFIG,
  DedupConfig,
  dedupSimilarPostings,
} from "../persistence/application/dedup-similar-postings";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../persistence/infrastructure/db";
import { PostingsRepository } from "../persistence/infrastructure/postings-repository";
import {
  RunsRepository,
  parseFailedSources,
} from "../persistence/infrastructure/runs-repository";
import { applyPreFilter } from "../prefilter/domain/pre-filter";
import { Criteria } from "../prefilter/domain/criteria";
import { loadCriteria } from "../prefilter/infrastructure/criteria-loader";
import { Profile } from "../profile/domain/profile";
import { loadProfile } from "../profile/infrastructure/profile-loader";
import { deriveProfileKeywords } from "../profile/domain/profile-keywords";
import { hashProfile } from "../profile/domain/profile-hash";
import { ScorerPort } from "../scoring/domain/ports/scorer.port";
import { buildScorer } from "../scoring/infrastructure/build-scorer";
import { NotifierPort } from "../delivery/domain/ports/notifier.port";
import { composeDigest, ScoredPosting } from "../delivery/domain/digest";
import {
  TelegramNotifier,
  TextNotifier,
} from "../delivery/infrastructure/telegram-notifier";
import { loadTelegramConfig } from "../delivery/infrastructure/telegram-config";
import { Taxonomy } from "../market/domain/taxonomy";
import { loadTaxonomy } from "../market/infrastructure/taxonomy-loader";
import { MarketRepository } from "../market/infrastructure/market-repository";
import { composeStudyPlan } from "../market/domain/study-plan";
import { renderStudyPlanText } from "../market/domain/render-study-plan";

export interface CollectOutcome {
  readonly runId: string;
  readonly collected: number;
  readonly normalized: number;
  /** Dropped by the recency window (ADR-019) — visible so a window that is
   * quietly discarding everything shows up instead of looking like a dead
   * source. */
  readonly tooOld: number;
  /** Postings from a source with no registered normalizer — a wiring bug,
   * not a degraded source, and it must not look like one. */
  readonly unnormalizable: number;
  readonly isNew: number;
  readonly alreadySeen: number;
  readonly error?: string;
}

const DEFAULT_QUERY_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The testable core of `collect`, independent of argv parsing. The collector
 * is injected — tests exercise this with a stub, no network call, matching
 * docs/07-testing-strategy.md.
 *
 * Takes a **list** of queries and folds them into **one** run row: a
 * collection cycle is one run regardless of how many questions it had to ask
 * the source (`config/criteria.yaml`'s `collection.queries`). Recording one
 * row per query instead would quietly break two things that count runs — the
 * digest's "collected since last delivery" summary, and
 * `evaluateCollectionHealth`, which alerts on consecutive *empty* collection
 * runs and would start firing whenever one of several queries legitimately
 * returned nothing.
 *
 * Partial failure is degraded, not down (principle 1): whatever succeeded is
 * persisted, the first error is reported on the outcome, and the run is
 * marked `failed` only when **every** query failed. One dead query out of
 * four must not look identical to a dead source.
 */
export interface RecencyWindow {
  readonly recencyDays: number;
  readonly backfillDays: number;
}

/**
 * Resolves the collector for a query's `source`. Production passes
 * `collectorFor`; tests pass a stub so no suite ever touches the network
 * (docs/07-testing-strategy.md).
 */
export type CollectorResolver = (source: string) => CollectorPort | null;

export async function executeCollect(
  db: Db,
  collectors: CollectorResolver,
  queries: readonly unknown[],
  now: () => Date = () => new Date(),
  queryIntervalMs: number = DEFAULT_QUERY_INTERVAL_MS,
  recency?: RecencyWindow,
): Promise<CollectOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);

  // "First run" is derived, not stored: no successful collect on record means
  // no previous cycle can have caught the last week, so the window reaches
  // back further exactly once (ADR-019). Read BEFORE this run is started, or
  // it would find itself.
  const isFirstRun = runsRepo.findLatestFinished("collect", "success") === null;
  const windowDays = recency
    ? isFirstRun
      ? recency.backfillDays
      : recency.recencyDays
    : null;
  const cutoff =
    windowDays === null
      ? null
      : new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000);

  const runId = runsRepo.start("collect", now());

  let collected = 0;
  let normalized = 0;
  let isNew = 0;
  let alreadySeen = 0;
  let failures = 0;
  let tooOld = 0;
  let unnormalizable = 0;
  let firstError: string | undefined;
  // Which source(s) actually failed this run (docs/11-known-issues.md B2) —
  // a Set because the same source can appear in several queries
  // (config/criteria.yaml's per-city Gupy queries) and should only be
  // reported once.
  const failedSources = new Set<string>();

  // Same bookkeeping guarantee `executeDeliver` documents: a throw between
  // `start` and `finish` must not leave the row open. Collectors cannot throw
  // (principle 1) and the normalizers use `safeParse`, so the realistic
  // trigger here is the database itself — a locked or full disk mid-upsert.
  // Narrower than the deliver case, identical in consequence.
  try {
    for (const [index, query] of queries.entries()) {
      // The collector's own interval only spaces out pages *within* one query,
      // so the gap between queries is this loop's responsibility (CLAUDE.md §6).
      if (index > 0 && queryIntervalMs > 0) await sleep(queryIntervalMs);

      // `source` decides who fetches, exactly as `RawPosting.source` decides
      // who normalizes. A query naming a source this build cannot collect from
      // is a config error, reported rather than skipped.
      const source =
        typeof query === "object" && query !== null && "source" in query
          ? String((query as { source?: unknown }).source ?? "gupy")
          : "gupy";
      const collector = collectors(source);
      if (!collector) {
        failures += 1;
        failedSources.add(source);
        firstError ??= `No collector registered for source "${source}"`;
        continue;
      }

      const result = await collector.collect(query);
      collected += result.postings.length;

      if (result.error) {
        failures += 1;
        failedSources.add(source);
        firstError ??= result.error.message;
        continue;
      }

      const collectedAt = now();
      for (const raw of result.postings) {
        // Dispatch by the source the payload declares, not by which collector
        // was passed in — an unregistered source is a wiring bug, and saying
        // so beats dropping every posting and looking like an empty source.
        const normalize = normalizerFor(raw.source);
        if (!normalize) {
          firstError ??= `No normalizer registered for source "${raw.source}"`;
          failedSources.add(raw.source);
          unnormalizable += 1;
          continue;
        }
        const posting = normalize(raw, collectedAt);
        if (!posting) continue;
        // A posting the source never dated passes: absence of a date is not
        // evidence of an old posting, the same leniency ADR-011 applies to an
        // unknown location/workMode.
        if (
          cutoff !== null &&
          posting.publishedAt !== null &&
          posting.publishedAt.getTime() < cutoff.getTime()
        ) {
          tooOld += 1;
          continue;
        }
        normalized += 1;
        const { wasNew } = postingsRepo.upsert(posting);
        if (wasNew) isNew += 1;
        else alreadySeen += 1;
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    runsRepo.finish(runId, now(), "failed", {
      collectedCount: collected,
      normalizedCount: normalized,
      newCount: isNew,
      alreadySeenCount: alreadySeen,
      tooOldCount: tooOld,
      unnormalizableCount: unnormalizable,
      failureReason: firstError ?? message,
      failedSources: [...failedSources],
    });
    throw cause;
  }

  const allFailed = failures === queries.length;
  runsRepo.finish(runId, now(), allFailed ? "failed" : "success", {
    collectedCount: collected,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
    tooOldCount: tooOld,
    unnormalizableCount: unnormalizable,
    failureReason: firstError ?? null,
    failedSources: [...failedSources],
  });

  return {
    runId,
    collected,
    normalized,
    tooOld,
    unnormalizable,
    isNew,
    alreadySeen,
    ...(firstError === undefined ? {} : { error: firstError }),
  };
}

export interface ExternalRawPosting {
  readonly sourceId: string;
  readonly payload: unknown;
}

export interface IngestExternalOutcome {
  readonly runId: string;
  readonly collected: number;
  readonly normalized: number;
  readonly unnormalizable: number;
  readonly isNew: number;
  readonly alreadySeen: number;
}

/**
 * The testable core of the external-ingest endpoint (ADR-027) — a source
 * that fetches outside this process (jobspy, in an ephemeral container on
 * Atlas's host, never inside the app container) and hands over already-
 * fetched raw postings instead of this process making the network call
 * itself. Everything after "already have the raw payloads" is identical to
 * `executeCollect`'s inner loop: normalize, upsert, count.
 *
 * `normalize` is passed in already resolved, not looked up by `source`
 * internally — the caller (`RunsService.ingestExternal`) rejects an
 * unregistered source with 400 before a run row is even opened, since every
 * item would be unnormalizable and starting a run to record that is not
 * useful. This function's contract is simpler as a result: given a working
 * normalizer, normalize and store this exact batch.
 *
 * No recency-window filtering (ADR-019/`executeCollect`'s `cutoff`) —
 * deliberately out of scope for v1. The pre-filter's `maxAgeDays`
 * (ADR-011 Amendment 4) already bounds what reaches the LLM regardless of
 * which stage a posting entered through, so skipping the window here costs
 * extra storage of an old posting, never extra LLM spend — see ADR-027's
 * consequences.
 *
 * Bookkeeping matches `executeCollect`/`executeDedup`: the run row closes
 * as `failed` before a throw is re-raised, never left open (#49).
 */
export async function executeIngestExternal(
  db: Db,
  source: string,
  normalize: Normalizer,
  postings: readonly ExternalRawPosting[],
  now: () => Date = () => new Date(),
): Promise<IngestExternalOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const runId = runsRepo.start("collect", now());

  let normalized = 0;
  let unnormalizable = 0;
  let isNew = 0;
  let alreadySeen = 0;

  try {
    const collectedAt = now();
    for (const raw of postings) {
      const posting = normalize(
        { source, sourceId: raw.sourceId, payload: raw.payload },
        collectedAt,
      );
      if (!posting) {
        unnormalizable += 1;
        continue;
      }
      normalized += 1;
      const { wasNew } = postingsRepo.upsert(posting);
      if (wasNew) isNew += 1;
      else alreadySeen += 1;
    }
  } catch (cause) {
    runsRepo.finish(runId, now(), "failed", {
      collectedCount: postings.length,
      normalizedCount: normalized,
      newCount: isNew,
      alreadySeenCount: alreadySeen,
    });
    throw cause;
  }

  runsRepo.finish(runId, now(), "success", {
    collectedCount: postings.length,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
  });

  return {
    runId,
    collected: postings.length,
    normalized,
    unnormalizable,
    isNew,
    alreadySeen,
  };
}

export interface DedupOutcome {
  readonly runId: string;
  readonly scanned: number;
  readonly markedDuplicate: number;
}

/** The testable core of `dedup`. Touches only PostingsRepository — no
 * collector, no network, at all. */
export function executeDedup(
  db: Db,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
  now: () => Date = () => new Date(),
): DedupOutcome {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const runId = runsRepo.start("dedup", now());

  let outcome;
  try {
    outcome = dedupSimilarPostings(postingsRepo, config);
  } catch (cause) {
    // See `executeCollect` — the row is closed before the throw is re-raised
    // so an open `finishedAt: null` can only ever mean "still running".
    runsRepo.finish(runId, now(), "failed", { duplicateCount: 0 });
    throw cause;
  }

  runsRepo.finish(runId, now(), "success", {
    duplicateCount: outcome.markedDuplicate,
  });

  return {
    runId,
    scanned: outcome.scanned,
    markedDuplicate: outcome.markedDuplicate,
  };
}

export interface DeliverOutcome {
  readonly runId: string;
  readonly filtered: number;
  readonly scored: number;
  readonly delivered: number;
  readonly error?: string;
}

/**
 * The testable core of `deliver`: pre-filter → score → compose → notify,
 * over every active, not-yet-notified posting (`findUnnotified`). A posting
 * that fails the pre-filter or scores `discard` is not marked notified — it
 * stays a candidate for the next run, the same "corpus is never deleted"
 * discipline the rest of the pipeline follows (ADR-007). Only postings that
 * actually appear in a *successfully sent* digest are marked, so a failed
 * send never causes a silent skip (ADR-007's re-run test).
 *
 * `collected`/`deduplicated` in the run summary are read from `collect` and
 * `dedup` runs since the last successful delivery, not from this run
 * itself — this run does not collect. `deduplicated` approximates "new
 * postings surviving dedup" as `newCount - duplicateCount` over that window,
 * clamped at zero, rather than joining against which specific postings were
 * marked duplicate; exact enough for a summary line, not for accounting.
 */
export async function executeDeliver(
  db: Db,
  scorer: ScorerPort,
  notifier: NotifierPort,
  criteria: Criteria,
  profile: Profile,
  now: () => Date = () => new Date(),
): Promise<DeliverOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const runId = runsRepo.start("scoreAndDeliver", now());
  const startedAt = now();

  // Counters live outside the try so the catch can record how far the run
  // actually got, rather than writing zeroes over a batch that filtered 200
  // postings and died on the 30th.
  let filteredCount = 0;
  let scoredCount = 0;

  // Every exit from here on must close the run row. It did not before: when
  // `scorer.score` threw (2026-08-16, a prompt template missing from the
  // container image), the row was left with `finishedAt: null` forever, which
  // `/health` reads as "still running" and `findLatestFinished` skips
  // entirely — so a hard failure was indistinguishable from a long batch, and
  // `lastSuccessfulRun` kept pointing at the previous day. The throw is
  // re-raised after bookkeeping: alerting is the caller's job, this only
  // makes sure the row tells the truth first.
  try {
    return await deliver();
  } catch (cause) {
    runsRepo.finish(runId, now(), "failed", {
      filteredCount,
      scoredCount,
      deliveredCount: 0,
    });
    throw cause;
  }

  async function deliver(): Promise<DeliverOutcome> {
    const lastDelivery = runsRepo.findLatestFinished(
      "scoreAndDeliver",
      "success",
    );
    const since = lastDelivery?.finishedAt ?? null;
    const collectRuns = runsRepo.findRunsSince("collect", since);
    const dedupRuns = runsRepo.findRunsSince("dedup", since);

    const collected = collectRuns.reduce((sum, r) => sum + r.collectedCount, 0);
    const newCount = collectRuns.reduce((sum, r) => sum + r.newCount, 0);
    const duplicateCount = dedupRuns.reduce(
      (sum, r) => sum + r.duplicateCount,
      0,
    );
    const deduplicated = Math.max(0, newCount - duplicateCount);
    // Real per-source breakdown (docs/11-known-issues.md B2) — each collect
    // run now records which source(s) actually failed it, so this is a
    // union over the window rather than a guess.
    const failedSources = [
      ...new Set(collectRuns.flatMap((r) => parseFailedSources(r))),
    ];

    const profileKeywords = deriveProfileKeywords(profile);
    const profileHash = hashProfile(profile);

    const filtered = postingsRepo
      .findUnnotified()
      .filter(
        (posting) =>
          applyPreFilter(posting, criteria, profileKeywords, startedAt).passed,
      );
    filteredCount = filtered.length;

    const scoredEntries: ScoredPosting[] = [];
    for (const posting of filtered) {
      const result = await scorer.score(posting, profileHash);
      if (result.ok) scoredEntries.push({ posting, outcome: result });
      scoredCount = scoredEntries.length;
    }

    const digest = composeDigest({
      runId,
      generatedAt: startedAt,
      scored: scoredEntries,
      periodBlocked: [],
      summary: {
        collected,
        deduplicated,
        filtered: filteredCount,
        scored: scoredCount,
        failedSources,
      },
    });

    const notifyResult = await notifier.notify(digest);

    if (!notifyResult.ok) {
      runsRepo.finish(runId, now(), "failed", {
        filteredCount,
        scoredCount,
        deliveredCount: 0,
      });
      return {
        runId,
        filtered: filteredCount,
        scored: scoredCount,
        delivered: 0,
        error: notifyResult.error.message,
      };
    }

    const deliveredAt = now();
    const sent = [...digest.recommended, ...digest.review];
    for (const entry of sent) {
      postingsRepo.markNotified(entry.posting.fingerprint, deliveredAt);
    }

    runsRepo.finish(runId, deliveredAt, "success", {
      filteredCount,
      scoredCount,
      deliveredCount: sent.length,
    });

    return {
      runId,
      filtered: filteredCount,
      scored: scoredCount,
      delivered: sent.length,
    };
  }
}

export interface StudyPlanOutcome {
  readonly corpusSize: number;
  readonly extractedCount: number;
  readonly highCompatibilityCount: number;
  readonly gapCount: number;
  readonly delivered: boolean;
  readonly error?: string;
}

/**
 * The testable core of `studyplan` (M10): assemble the corpus via
 * `MarketRepository`, compose the ranked plan, render it in pt-BR, send it
 * — "delivered to Telegram on request" (docs/10-milestones.md), not on the
 * nightly cron, so this has no `RunsRepository` row of its own the way
 * `collect`/`dedup`/`scoreAndDeliver` do: it reads the corpus, it never
 * mutates it, and there is nothing here for a missed-run alert to watch.
 */
export async function executeStudyPlan(
  db: Db,
  criteria: Criteria,
  profile: Profile,
  taxonomy: Taxonomy,
  notifier: TextNotifier,
  now: () => Date = () => new Date(),
): Promise<StudyPlanOutcome> {
  const profileHash = hashProfile(profile);
  const entries = new MarketRepository(db, criteria).loadCorpus(profileHash);
  const plan = composeStudyPlan(entries, profile, taxonomy, now());
  const text = renderStudyPlanText(plan);

  const notifyResult = await notifier.sendText(text);

  return {
    corpusSize: plan.corpusSize,
    extractedCount: plan.extractedCount,
    highCompatibilityCount: plan.highCompatibilityCount,
    gapCount: plan.gaps.length,
    delivered: notifyResult.ok,
    ...(notifyResult.ok ? {} : { error: notifyResult.error.message }),
  };
}

function openDatabase(): Db {
  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const db = createDatabase(databasePath);
  runMigrations(db);
  return db;
}

async function collectCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "job-name": { type: "string" },
      city: { type: "string" },
      "max-results": { type: "string" },
      "since-days": { type: "string" },
    },
  });

  const adHoc = {
    jobName: values["job-name"],
    city: values.city,
    maxResults: values["max-results"]
      ? Number(values["max-results"])
      : undefined,
  };

  // No flags means "run the configured cycle" — the same queries the cron
  // issues (`config/criteria.yaml`, `collection.queries`), so a manual run
  // and a scheduled one exercise the identical path. Any flag makes it a
  // deliberate one-off that overrides the configuration.
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const isAdHoc = Object.values(adHoc).some((value) => value !== undefined);
  const queries = isAdHoc ? [adHoc] : criteria.collection.queries;

  /**
   * `--since-days` widens the recency window for one manual run. It exists
   * for a specific, real situation: adding a query term to
   * `collection.queries` does **not** backfill, because everything the new
   * term finds was published before the one-day window (ADR-019). Without
   * this the only way to pick those up is to wait for them to be reposted.
   * Deliberately manual — the scheduled cycle always uses the configured
   * window.
   */
  const sinceDays = values["since-days"]
    ? Number(values["since-days"])
    : undefined;
  if (
    sinceDays !== undefined &&
    (!Number.isFinite(sinceDays) || sinceDays <= 0)
  ) {
    console.error("collect: --since-days must be a positive number");
    process.exitCode = 1;
    return;
  }
  const recency =
    sinceDays === undefined
      ? criteria.collection
      : { recencyDays: sinceDays, backfillDays: sinceDays };

  const outcome = await executeCollect(
    openDatabase(),
    collectorFor,
    queries,
    () => new Date(),
    criteria.collection.queryIntervalMs,
    recency,
  );

  if (outcome.error) {
    console.error(`collect (run ${outcome.runId}) failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `collect (run ${outcome.runId}): ${outcome.collected} collected, ` +
      `${outcome.normalized} normalized, ${outcome.tooOld} outside the recency window, ` +
      (outcome.unnormalizable > 0
        ? `${outcome.unnormalizable} with no normalizer, `
        : "") +
      `${outcome.isNew} new, ${outcome.alreadySeen} already seen`,
  );
}

function dedupCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      "similarity-threshold": { type: "string" },
      "window-days": { type: "string" },
      reset: { type: "boolean" },
    },
  });

  const db = openDatabase();
  // `--reset` clears existing flags first, so a corrected pass can re-decide
  // every posting. Needed because markDuplicate only ever sets: fixing the
  // rule does not un-flag what the old rule got wrong.
  if (values.reset) {
    const cleared = new PostingsRepository(db).clearDuplicateFlags();
    console.log(`dedup --reset: cleared ${cleared} existing duplicate flags`);
  }

  const outcome = executeDedup(db, {
    similarityThreshold: values["similarity-threshold"]
      ? Number(values["similarity-threshold"])
      : DEFAULT_DEDUP_CONFIG.similarityThreshold,
    windowDays: values["window-days"]
      ? Number(values["window-days"])
      : DEFAULT_DEDUP_CONFIG.windowDays,
  });

  console.log(
    `dedup (run ${outcome.runId}): scanned ${outcome.scanned}, marked ${outcome.markedDuplicate} as duplicates`,
  );
}

async function deliverCommand(): Promise<void> {
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );

  const db = openDatabase();
  const built = buildScorer(db, criteria, profile);
  if (!built.ok) {
    console.error(`deliver: ${built.error}`);
    process.exitCode = 1;
    return;
  }
  const { scorer } = built;

  const notifier = new TelegramNotifier(loadTelegramConfig());

  const outcome = await executeDeliver(db, scorer, notifier, criteria, profile);

  if (outcome.error) {
    console.error(`deliver (run ${outcome.runId}) failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `deliver (run ${outcome.runId}): ${outcome.filtered} passed the pre-filter, ` +
      `${outcome.scored} scored, ${outcome.delivered} delivered`,
  );
}

async function studyPlanCommand(): Promise<void> {
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const taxonomy = loadTaxonomy(
    process.env.TAXONOMY_PATH ?? "./config/taxonomy.yaml",
  );

  const db = openDatabase();
  const notifier = new TelegramNotifier(loadTelegramConfig());

  const outcome = await executeStudyPlan(
    db,
    criteria,
    profile,
    taxonomy,
    notifier,
  );

  if (outcome.error) {
    console.error(`studyplan failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `studyplan: ${outcome.corpusSize} postings in corpus, ${outcome.extractedCount} extracted, ` +
      `${outcome.highCompatibilityCount} high-compatibility, ${outcome.gapCount} gaps identified, delivered`,
  );
}

/**
 * Records a human decision — never surfaced again, regardless of a later
 * profile edit or re-scoring — the same core `PostingsRepository.discard`
 * `PostingsService` (M9's REST/MCP surface) calls, so the CLI and Hermes
 * can never implement "discard this posting" two different ways.
 */
function discardCommand(args: string[]): void {
  const { positionals, values } = parseArgs({
    args,
    options: { reason: { type: "string" } },
    allowPositionals: true,
  });

  const fingerprint = positionals[0];
  if (!fingerprint) {
    console.error("Usage: argos discard <fingerprint> [--reason <text>]");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const found = new PostingsRepository(db).discard(
    fingerprint,
    new Date(),
    values.reason ?? null,
  );

  if (!found) {
    console.error(`discard: no posting with fingerprint ${fingerprint}`);
    process.exitCode = 1;
    return;
  }

  console.log(`discard: ${fingerprint} will never be surfaced again`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "collect":
      await collectCommand(rest);
      break;
    case "dedup":
      dedupCommand(rest);
      break;
    case "deliver":
      await deliverCommand();
      break;
    case "studyplan":
      await studyPlanCommand();
      break;
    case "discard":
      discardCommand(rest);
      break;
    default:
      console.error(
        "Usage: argos <collect|dedup|deliver|studyplan|discard> [options]",
      );
      process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
