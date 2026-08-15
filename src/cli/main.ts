#!/usr/bin/env node
/**
 * Each pipeline stage invocable independently, the actual test of principle 2
 * (docs/02-architecture.md) for this milestone: `dedup` re-scans the corpus
 * for near-duplicates without touching a collector or the network at all.
 *
 *   argos collect [--job-name <text>] [--city <text>] [--max-results <n>]
 *   argos dedup [--similarity-threshold <0-1>] [--window-days <n>]
 *   argos deliver
 */
import { parseArgs } from "node:util";
import { CollectorPort } from "../posting/domain/ports/collector.port";
import { normalizeGupyJob } from "../posting/infrastructure/gupy-normalizer";
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
import { TelegramNotifier } from "../delivery/infrastructure/telegram-notifier";
import { loadTelegramConfig } from "../delivery/infrastructure/telegram-config";

export interface CollectOutcome {
  readonly runId: string;
  readonly collected: number;
  readonly normalized: number;
  readonly isNew: number;
  readonly alreadySeen: number;
  readonly error?: string;
}

/**
 * The testable core of `collect`, independent of argv parsing. The collector
 * is injected — tests exercise this with a stub, no network call, matching
 * docs/07-testing-strategy.md.
 */
export async function executeCollect(
  db: Db,
  collector: CollectorPort,
  criteria: unknown,
  now: () => Date = () => new Date(),
): Promise<CollectOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const runId = runsRepo.start("collect", now());

  const result = await collector.collect(criteria);

  if (result.error) {
    runsRepo.finish(runId, now(), "failed", {
      collectedCount: result.postings.length,
    });
    return {
      runId,
      collected: result.postings.length,
      normalized: 0,
      isNew: 0,
      alreadySeen: 0,
      error: result.error.message,
    };
  }

  const collectedAt = now();
  let normalized = 0;
  let isNew = 0;
  let alreadySeen = 0;

  for (const raw of result.postings) {
    const posting = normalizeGupyJob(raw, collectedAt);
    if (!posting) continue;
    normalized += 1;
    const { wasNew } = postingsRepo.upsert(posting);
    if (wasNew) isNew += 1;
    else alreadySeen += 1;
  }

  runsRepo.finish(runId, now(), "success", {
    collectedCount: result.postings.length,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
  });

  return {
    runId,
    collected: result.postings.length,
    normalized,
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
    },
  });

  const outcome = await executeCollect(openDatabase(), new GupyCollector(), {
    jobName: values["job-name"],
    city: values.city,
    maxResults: values["max-results"]
      ? Number(values["max-results"])
      : undefined,
  });

  if (outcome.error) {
    console.error(`collect (run ${outcome.runId}) failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `collect (run ${outcome.runId}): ${outcome.collected} collected, ` +
      `${outcome.normalized} normalized, ${outcome.isNew} new, ${outcome.alreadySeen} already seen`,
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
    default:
      console.error("Usage: argos <collect|dedup|deliver> [options]");
      process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
