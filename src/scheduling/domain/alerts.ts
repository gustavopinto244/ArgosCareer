import {
  parseLlmErrorTypeCounts,
  parseLlmOutcomeCounts,
  parseLlmProviderCounts,
  parseScoreFailureCounts,
  RunRow,
} from "../../persistence/infrastructure/runs-repository";

/**
 * `docs/08-observability.md`'s alerting table, as pure functions over
 * `RunRow[]` already returned by `RunsRepository`. No I/O here — the
 * scheduler infrastructure calls these after a cron tick and sends whatever
 * comes back through `TelegramNotifier.sendText`. Kept pure so every branch
 * is a unit test against constructed fixtures, not a real cron or a real
 * Telegram call (docs/07-testing-strategy.md).
 */
export interface Alert {
  readonly text: string;
}

/**
 * Consecutive-empty and consecutive-errored collection runs (the canonical
 * silent failure of principle 1). `recentRuns` must be `kind: "collect"`
 * runs ordered most-recent-first — the caller's responsibility, since
 * ordering is a query concern this function has no I/O to perform itself.
 *
 * Tolerant by design (docs/08): collection runs every few hours, so a single
 * quiet or failed cycle is routine. Only `threshold` in a row, both counted
 * from the most recent run backward, trigger an alert. Fewer than
 * `threshold` runs recorded yet is "not enough data", not an alert.
 */
export function evaluateCollectionHealth(
  recentRuns: readonly RunRow[],
  threshold: number,
): Alert[] {
  const alerts: Alert[] = [];
  if (recentRuns.length < threshold) return alerts;

  const lastN = recentRuns.slice(0, threshold);

  if (lastN.every((r) => r.outcome === "success" && r.collectedCount === 0)) {
    alerts.push({
      text: `gupy: ${threshold} consecutive collection runs found zero postings.`,
    });
  }

  if (lastN.every((r) => r.outcome === "failed")) {
    alerts.push({
      text: `gupy: ${threshold} consecutive collection runs errored.`,
    });
  }

  return alerts;
}

/**
 * A single `scoreAndDeliver` run's own outcome. Digest impact and scorer
 * health are separate signals: any posting left without a score is real
 * user impact, while an attempt-rate alert needs a minimum sample and says
 * nothing about regression unless a separate baseline proves one.
 */
const MIN_LLM_ATTEMPTS_FOR_RATE_ALERT = 10;

function countSummary(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

export function evaluateDeliveryOutcome(
  run: RunRow,
  failureRateThreshold: number,
): Alert[] {
  const alerts: Alert[] = [];

  if (run.outcome === "failed") {
    alerts.push({ text: `Delivery failed (run ${run.runId}).` });
  }

  const missingScores = Math.max(0, run.filteredCount - run.scoredCount);
  if (missingScores > 0) {
    const persistedCounts = parseScoreFailureCounts(run);
    const persistedTotal = Object.values(persistedCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const failureCounts =
      persistedTotal === missingScores
        ? persistedCounts
        : { unclassified: missingScores };
    const breakdown = countSummary(failureCounts);
    alerts.push({
      text: `Scoring impact on run ${run.runId}: ${missingScores}/${run.filteredCount} postings were left without a score${breakdown ? ` (${breakdown})` : ""}.`,
    });
  }

  const outcomeCounts = parseLlmOutcomeCounts(run);
  const accountedAttempts = Object.values(outcomeCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const totalOperations = run.llmAttempts + run.llmBlockedByCircuit;
  if (
    run.llmAttempts >= MIN_LLM_ATTEMPTS_FOR_RATE_ALERT &&
    accountedAttempts === run.llmAttempts &&
    totalOperations > 0
  ) {
    const failedOperations = totalOperations - (outcomeCounts.success ?? 0);
    const failureRate = failedOperations / totalOperations;
    if (failureRate >= failureRateThreshold) {
      const outcomes = countSummary(
        Object.fromEntries(
          Object.entries(outcomeCounts).filter(([name]) => name !== "success"),
        ),
      );
      const providers = countSummary(parseLlmProviderCounts(run));
      const errorTypes = countSummary(parseLlmErrorTypeCounts(run));
      const details = [
        outcomes && `outcomes: ${outcomes}`,
        providers && `providers: ${providers}`,
        errorTypes && `error types: ${errorTypes}`,
        run.llmBlockedByCircuit > 0 &&
          `circuit blocks: ${run.llmBlockedByCircuit}`,
      ].filter(Boolean);
      alerts.push({
        text: `Scorer health on run ${run.runId}: ${failedOperations}/${totalOperations} LLM operations failed (${(failureRate * 100).toFixed(0)}%)${details.length > 0 ? ` — ${details.join("; ")}` : ""}.`,
      });
    }
  }

  return alerts;
}

/**
 * Formats an instant as `YYYY-MM-DD HH:mm` in `timeZone` — a
 * lexicographically comparable wall-clock string, using `Intl` (built into
 * Node's ICU, no dependency added) rather than reimplementing timezone
 * offset arithmetic.
 */
function wallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export interface MissedRunConfig {
  readonly scoreAndDeliver: {
    readonly time: string;
    readonly timezone: string;
  };
  readonly collection: { readonly intervalHours: number };
}

/**
 * The two missed-run checks, deliberately asymmetric (ADR-009): a missed
 * `scoreAndDeliver` run means no digest that day, so it alerts on the
 * **first** miss; a missed `collection` cycle self-heals a few hours later,
 * so it alerts only after **two** in a row.
 */
export function evaluateMissedRuns(
  now: Date,
  lastSuccessfulDeliver: RunRow | null,
  lastSuccessfulCollect: RunRow | null,
  config: MissedRunConfig,
): Alert[] {
  const alerts: Alert[] = [];
  const { time, timezone } = config.scoreAndDeliver;

  const nowWallClock = wallClock(now, timezone);
  const [nowDate, nowTime] = nowWallClock.split(" ") as [string, string];
  const scheduledPassedToday = nowTime >= time;

  if (scheduledPassedToday) {
    const lastDeliverDate = lastSuccessfulDeliver
      ? wallClock(lastSuccessfulDeliver.finishedAt ?? now, timezone).split(
          " ",
        )[0]
      : null;
    if (lastDeliverDate !== nowDate) {
      alerts.push({
        text: `No successful scoreAndDeliver run today (scheduled ${time} ${timezone}) — no digest sent.`,
      });
    }
  }

  const missedCollectionThresholdMs =
    2 * config.collection.intervalHours * 60 * 60 * 1000;
  const lastCollectAt = lastSuccessfulCollect?.finishedAt ?? null;
  if (
    lastCollectAt === null ||
    now.getTime() - lastCollectAt.getTime() > missedCollectionThresholdMs
  ) {
    alerts.push({
      text: `No successful collection run in the last ${2 * config.collection.intervalHours}h (two cycles).`,
    });
  }

  return alerts;
}
