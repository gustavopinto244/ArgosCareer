#!/usr/bin/env node
/**
 * Each pipeline stage invocable independently, the actual test of principle 2
 * (docs/02-architecture.md) for this milestone: `dedup` re-scans the corpus
 * for near-duplicates without touching a collector or the network at all.
 *
 *   argos collect [--job-name <text>] [--city <text>] [--max-results <n>]
 *                 [--since-days <n>]  # one-off wider window, e.g. after
 *                                     # adding a query term (ADR-019)
 *   argos dedup [--similarity-threshold <0-1>] [--window-days <n>]
 *   argos deliver
 *   argos studyplan
 */
import { parseArgs } from "node:util";
import { CollectorPort } from "../posting/domain/ports/collector.port";
import { normalizerFor } from "../posting/infrastructure/normalizer-registry";
import { GupyCollector } from "../posting/infrastructure/gupy-collector";
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
import { RunsRepository } from "../persistence/infrastructure/runs-repository";
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

export async function executeCollect(
  db: Db,
  collector: CollectorPort,
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

  for (const [index, query] of queries.entries()) {
    // The collector's own interval only spaces out pages *within* one query,
    // so the gap between queries is this loop's responsibility (CLAUDE.md §6).
    if (index > 0 && queryIntervalMs > 0) await sleep(queryIntervalMs);

    const result = await collector.collect(query);
    collected += result.postings.length;

    if (result.error) {
      failures += 1;
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

  const allFailed = failures === queries.length;
  runsRepo.finish(runId, now(), allFailed ? "failed" : "success", {
    collectedCount: collected,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
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

  const outcome = dedupSimilarPostings(postingsRepo, config);

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
  // Only one collector exists in M6 (Gupy) and runs carry no per-source
  // breakdown yet — a failed collect run in the window is reported as
  // "gupy" until a multi-source run records which source actually failed.
  const failedSources = collectRuns.some((r) => r.outcome === "failed")
    ? ["gupy"]
    : [];

  const profileKeywords = deriveProfileKeywords(profile);
  const profileHash = hashProfile(profile);

  const filtered = postingsRepo
    .findUnnotified()
    .filter(
      (posting) =>
        applyPreFilter(posting, criteria, profileKeywords, startedAt).passed,
    );

  const scoredEntries: ScoredPosting[] = [];
  for (const posting of filtered) {
    const result = await scorer.score(posting, profileHash);
    if (result.ok) scoredEntries.push({ posting, outcome: result });
  }

  const digest = composeDigest({
    runId,
    generatedAt: startedAt,
    scored: scoredEntries,
    periodBlocked: [],
    summary: {
      collected,
      deduplicated,
      filtered: filtered.length,
      scored: scoredEntries.length,
      failedSources,
    },
  });

  const notifyResult = await notifier.notify(digest);

  if (!notifyResult.ok) {
    runsRepo.finish(runId, now(), "failed", {
      filteredCount: filtered.length,
      scoredCount: scoredEntries.length,
      deliveredCount: 0,
    });
    return {
      runId,
      filtered: filtered.length,
      scored: scoredEntries.length,
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
    filteredCount: filtered.length,
    scoredCount: scoredEntries.length,
    deliveredCount: sent.length,
  });

  return {
    runId,
    filtered: filtered.length,
    scored: scoredEntries.length,
    delivered: sent.length,
  };
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
    new GupyCollector(),
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
    },
  });

  const outcome = executeDedup(openDatabase(), {
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
    default:
      console.error("Usage: argos <collect|dedup|deliver|studyplan> [options]");
      process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
