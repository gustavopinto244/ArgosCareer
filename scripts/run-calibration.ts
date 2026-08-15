/**
 * Runs the M7 calibration protocol (docs/04-scoring-model.md) against the
 * hand-labeled worksheet (npm run calibration:generate): scores every
 * labeled posting with the real scorer configured via .env, then prints
 * correlation, verdict precision/recall and the parse-failure rate.
 *
 * One run == one configuration. Comparing model, prompt, weight or cutoff
 * changes means changing exactly one of them and running this again — the
 * calibration protocol's "one variable at a time" rule, not something this
 * script enforces for you.
 *
 * Run: npm run calibration:run
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { ExtractionsRepository } from "../src/persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../src/persistence/infrastructure/matches-repository";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { hashProfile } from "../src/profile/domain/profile-hash";
import { OpenRouterClient } from "../src/scoring/infrastructure/openrouter-client";
import { StageAExtractor } from "../src/scoring/infrastructure/stage-a-extractor";
import { StageBMatcher } from "../src/scoring/infrastructure/stage-b-matcher";
import { ApiScorer } from "../src/scoring/infrastructure/api-scorer";
import {
  CalibrationEntry,
  computeCalibrationReport,
} from "../src/scoring/domain/calibration";
import { Verdict } from "../src/scoring/domain/types";

interface LabeledPosting {
  readonly fingerprint: string;
  readonly company: string;
  readonly title: string;
  readonly handScore: number | null;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function formatCorrelation(value: number | null): string {
  return value === null ? "n/a (not enough data)" : value.toFixed(3);
}

async function main(): Promise<void> {
  const labelsPath =
    process.env.CALIBRATION_LABELS_PATH ?? "./data/calibration/labels.yaml";
  const labeled = (
    parse(readFileSync(labelsPath, "utf8")) as LabeledPosting[]
  ).filter((p) => p.handScore !== null);

  if (labeled.length === 0) {
    console.error(
      `No labeled postings found in ${labelsPath} — fill in handScore first.`,
    );
    process.exitCode = 1;
    return;
  }

  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const db = createDatabase(databasePath);
  runMigrations(db);

  const postingsRepo = new PostingsRepository(db);
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const profileHash = hashProfile(profile);

  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) {
    console.error("LLM_API_KEY and LLM_MODEL are required (ADR-012).");
    process.exitCode = 1;
    return;
  }

  const client = new OpenRouterClient({
    apiKey,
    model,
    ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
  });
  const ask = client.complete.bind(client);
  const scorer = new ApiScorer(
    new StageAExtractor(ask, new ExtractionsRepository(db)),
    new StageBMatcher(ask, new MatchesRepository(db)),
    profile,
    criteria,
    postingsRepo,
  );

  const entries: CalibrationEntry[] = [];
  for (const [index, labeledPosting] of labeled.entries()) {
    const posting = postingsRepo.findByFingerprint(labeledPosting.fingerprint);
    if (!posting) {
      console.error(
        `Skipping ${labeledPosting.company} — "${labeledPosting.title}": posting no longer in the corpus`,
      );
      continue;
    }

    console.error(
      `[${index + 1}/${labeled.length}] Scoring ${labeledPosting.company} — "${labeledPosting.title}"...`,
    );
    const result = await scorer.score(posting, profileHash);

    entries.push({
      fingerprint: labeledPosting.fingerprint,
      handScore: labeledPosting.handScore as number,
      computedScore: result.ok ? result.score : null,
      computedVerdict: result.ok ? result.verdict : null,
    });

    if (!result.ok) {
      console.error(
        `  -> scoring failed: ${result.reason} (${result.attempts} attempts)`,
      );
    }
  }

  const report = computeCalibrationReport(entries, criteria.scoring.thresholds);

  console.log("\n=== Calibration report ===");
  console.log(`Model: ${model}`);
  console.log(
    `n = ${report.n}, scored = ${report.scored}, parse-failure rate = ${formatPercent(report.parseFailureRate)}`,
  );
  console.log(
    `Correlation (computed vs hand score): ${formatCorrelation(report.correlation)}`,
  );
  console.log("\n| Verdict | Support | Precision | Recall |");
  console.log("| ------- | ------- | --------- | ------ |");
  for (const verdict of [
    "apply",
    "review",
    "discard",
  ] as const satisfies readonly Verdict[]) {
    const m = report.verdictMetrics[verdict];
    console.log(
      `| ${verdict} | ${m.support} | ${formatPercent(m.precision)} | ${formatPercent(m.recall)} |`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("Calibration run failed:", error);
  process.exitCode = 1;
});
