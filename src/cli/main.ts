#!/usr/bin/env node
/**
 * Each pipeline stage invocable independently, the actual test of principle 2
 * (docs/02-architecture.md) for this milestone: `dedup` re-scans the corpus
 * for near-duplicates without touching a collector or the network at all.
 *
 *   argos collect [--job-name <text>] [--city <text>] [--max-results <n>]
 *   argos dedup [--similarity-threshold <0-1>] [--window-days <n>]
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

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "collect":
      await collectCommand(rest);
      break;
    case "dedup":
      dedupCommand(rest);
      break;
    default:
      console.error("Usage: argos <collect|dedup> [options]");
      process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
