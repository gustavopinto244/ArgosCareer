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
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { hashProfile } from "../src/profile/domain/profile-hash";
import { buildScorer } from "../src/scoring/infrastructure/build-scorer";
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

  const model = process.env.LLM_MODEL;
  if (!model) {
    console.error("LLM_MODEL is required.");
    process.exitCode = 1;
    return;
  }

  const adapter = process.env.SCORER_ADAPTER ?? "api";
  if (adapter !== "api") {
    console.error(
      `SCORER_ADAPTER=${adapter} is not a calibratable adapter (only "api" is, ADR-016).`,
    );
    process.exitCode = 1;
    return;
  }

  // Built the same way production scoring is (buildScorer, shared with the
  // scheduler and the CLI) so calibration exercises the exact same timeouts
  // and reasoning.max_tokens caps as a real run — a separately constructed
  // client here previously reproduced the pre-ADR-052 B6 incident's 30s
  // timeouts and unbounded reasoning, invalidating everything it measured.
  const built = buildScorer(db, criteria, profile);
  if (!built.ok) {
    console.error(built.error);
    process.exitCode = 1;
    return;
  }
  const scorer = built.scorer;

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
    } else {
      const b = result.breakdown;
      console.error(
        `  -> hand ${labeledPosting.handScore} vs computed ${result.score} (${result.verdict})` +
          ` | mandatory ${(b.mandatoryCoverage * 100).toFixed(0)}%` +
          ` desirable ${(b.desirableCoverage * 100).toFixed(0)}%` +
          ` track ${(b.trackAlignment * 100).toFixed(0)}%` +
          (result.blockingFailure
            ? ` | BLOCKED by "${result.blockingFailure.text}"`
            : ""),
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

  // What this configuration actually cost. A calibration run is repeated once
  // per configuration by design, so an unnoticed inefficiency is paid for
  // every time — printing it is what keeps that visible (ADR-014). A high
  // `cached` share is the prompt-cache reorder in `b-v2` doing its job; a
  // near-zero one means the shared prefix is not being reused.
  if (built.getUsage) {
    const usage = built.getUsage();
    const cachedShare =
      usage.promptTokens > 0
        ? `${((usage.cachedPromptTokens / usage.promptTokens) * 100).toFixed(0)}%`
        : "n/a";
    console.log(
      `\nModel calls: ${usage.calls} | prompt tokens: ${usage.promptTokens} (cached ${usage.cachedPromptTokens}, ${cachedShare}) | completion tokens: ${usage.completionTokens}`,
    );
    console.log(`Run cost: $${usage.costUsd.toFixed(4)}`);
  }
}

main().catch((error: unknown) => {
  console.error("Calibration run failed:", error);
  process.exitCode = 1;
});
