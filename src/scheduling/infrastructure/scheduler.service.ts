import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { executeCollect, executeDedup, executeDeliver } from "../../cli/main";
import { backupDatabase } from "../../persistence/infrastructure/backup";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../persistence/infrastructure/db";
import { RunsRepository } from "../../persistence/infrastructure/runs-repository";
import { GupyCollector } from "../../posting/infrastructure/gupy-collector";
import { Criteria } from "../../prefilter/domain/criteria";
import { loadCriteria } from "../../prefilter/infrastructure/criteria-loader";
import { Profile } from "../../profile/domain/profile";
import { loadProfile } from "../../profile/infrastructure/profile-loader";
import { buildScorer } from "../../scoring/infrastructure/build-scorer";
import { TelegramNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { loadTelegramConfig } from "../../delivery/infrastructure/telegram-config";
import {
  Alert,
  evaluateCollectionHealth,
  evaluateDeliveryOutcome,
  evaluateMissedRuns,
} from "../domain/alerts";

/**
 * Turns `schedule.collection.intervalHours` into a standard 5-field cron
 * expression firing at minute 0 of every Nth hour — the same shape a crontab
 * entry for "every N hours" would use. `schedule.scoreAndDeliver.time` is
 * `HH:mm`, already validated by `CriteriaSchema`.
 */
export function collectionCronExpression(intervalHours: number): string {
  return `0 */${intervalHours} * * *`;
}

export function deliverCronExpression(time: string): string {
  const [hour, minute] = time.split(":");
  return `${minute} ${hour} * * *`;
}

/**
 * ADR-009's two independent crons, wired through `@nestjs/schedule`
 * (CLAUDE.md §4/§14, M8). Registered dynamically via `SchedulerRegistry`
 * rather than the `@Cron` decorator — the decorator needs a compile-time
 * literal, and the actual schedule is only known once `criteria.yaml` loads.
 *
 * Both handlers call the same `execute*` functions the CLI's `collect`,
 * `dedup` and `deliver` commands already use and are already tested against
 * (`src/cli/main.ts`) — one code path for "run this stage" regardless of
 * what triggered it (principle 2), not a second implementation that could
 * drift from the first.
 *
 * Config (`criteria.yaml`, `profile.yaml`, the database handle) is read
 * once, in `onModuleInit` (`docs/09-configuration.md` rule 5: "config is
 * read once at startup, not per stage") — a mid-deployment edit takes effect
 * on the next container restart, not mid-batch.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  // Definite-assignment (`!`), not `readonly` — assigned in `onModuleInit`,
  // not the constructor; see the comment below for why.
  private db!: Db;
  private criteria!: Criteria;
  private profile!: Profile;
  private notifier!: TelegramNotifier;

  // Explicit @Inject rather than relying on reflected constructor-parameter
  // metadata: `npm run dev` runs this under `tsx` (esbuild), whose
  // `emitDecoratorMetadata` support is incomplete enough that plain
  // type-based injection silently resolves to `undefined` here — verified
  // by booting the real `tsc` build (works) against `tsx` (does not) while
  // building this service. An explicit token sidesteps the gap in both.
  //
  // Config loading and the database handle live in `onModuleInit`, not
  // here — a constructor that reads files and env vars means the module
  // graph cannot even be *compiled* (e.g. in a test) without a fully
  // configured environment already in place, which is a stricter
  // requirement than DI wiring itself should have.
  constructor(
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.db = createDatabase(process.env.DATABASE_PATH ?? "./data/argos.db");
    runMigrations(this.db);
    this.criteria = loadCriteria(
      process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
    );
    this.profile = loadProfile(
      process.env.PROFILE_PATH ?? "./config/profile.yaml",
    );
    this.notifier = new TelegramNotifier(loadTelegramConfig());

    const { collection, scoreAndDeliver } = this.criteria.schedule;

    const collectionJob = CronJob.from({
      cronTime: collectionCronExpression(collection.intervalHours),
      onTick: () => void this.runCollectionCycle(),
      start: true,
    });
    this.registry.addCronJob("collection", collectionJob);

    const deliverJob = CronJob.from({
      cronTime: deliverCronExpression(scoreAndDeliver.time),
      timeZone: scoreAndDeliver.timezone,
      onTick: () => void this.runScoreAndDeliverCycle(),
      start: true,
    });
    this.registry.addCronJob("scoreAndDeliver", deliverJob);

    this.logger.log(
      `Scheduled: collection every ${collection.intervalHours}h, ` +
        `scoreAndDeliver daily at ${scoreAndDeliver.time} ${scoreAndDeliver.timezone}.`,
    );
  }

  /** Collect → dedup, then check collection-health and missed-run alerts —
   * the natural place for the missed-run check, since this cycle already
   * runs every few hours regardless of what it finds (docs/08). */
  private async runCollectionCycle(): Promise<void> {
    try {
      await executeCollect(
        this.db,
        new GupyCollector(),
        this.criteria.collection.queries,
        () => new Date(),
        this.criteria.collection.queryIntervalMs,
      );
      executeDedup(this.db);
    } catch (cause) {
      this.logger.error("Collection cycle threw unexpectedly", cause);
    }

    await this.sendAlerts(this.evaluateAfterCollection());
  }

  private async runScoreAndDeliverCycle(): Promise<void> {
    const runsRepo = new RunsRepository(this.db);
    const built = buildScorer(this.db, this.criteria, this.profile);

    if (!built.ok) {
      await this.sendAlerts([
        { text: `scoreAndDeliver misconfigured: ${built.error}` },
      ]);
      return;
    }

    try {
      const outcome = await executeDeliver(
        this.db,
        built.scorer,
        this.notifier,
        this.criteria,
        this.profile,
      );

      const run = runsRepo.findById(outcome.runId);
      if (run) {
        await this.sendAlerts(
          evaluateDeliveryOutcome(
            run,
            this.criteria.alerts.scoreFailureRateThreshold,
          ),
        );
      }
    } catch (cause) {
      this.logger.error("scoreAndDeliver cycle threw unexpectedly", cause);
      await this.sendAlerts([
        { text: "scoreAndDeliver cycle threw an unexpected error." },
      ]);
    }

    this.runBackup();
  }

  /**
   * Chained directly after the nightly cycle finishes, rather than a fourth
   * cron expression offset by some guessed number of minutes from
   * `scoreAndDeliver.time` — that would race the actual run length instead
   * of following it. `executeDeliver` has already called `runsRepo.finish`
   * by the time control returns here (both on success and on failure), so
   * there is never an unfinished run for the backup to catch mid-write.
   *
   * Synchronous and best-effort: a failed backup is logged and alerted, not
   * thrown — a backup failure must not be mistaken for a pipeline failure
   * principle 1 already has its own alerting for.
   */
  private runBackup(): void {
    try {
      const result = backupDatabase(
        process.env.DATABASE_PATH ?? "./data/argos.db",
        process.env.BACKUPS_DIR ?? "./backups",
      );
      this.logger.log(`Backed up database to ${result.path}`);
    } catch (cause) {
      this.logger.error("Nightly backup failed", cause);
      void this.sendAlerts([{ text: "Nightly database backup failed." }]);
    }
  }

  private evaluateAfterCollection(): Alert[] {
    const runsRepo = new RunsRepository(this.db);
    const threshold = this.criteria.alerts.consecutiveEmptyCollectionRuns;

    const recentCollectRuns = runsRepo
      .findRunsSince("collect", null)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, threshold);

    const collectionAlerts = evaluateCollectionHealth(
      recentCollectRuns,
      threshold,
    );

    const missedRunAlerts = evaluateMissedRuns(
      new Date(),
      runsRepo.findLatestFinished("scoreAndDeliver", "success"),
      runsRepo.findLatestFinished("collect", "success"),
      this.criteria.schedule,
    );

    return [...collectionAlerts, ...missedRunAlerts];
  }

  private async sendAlerts(alerts: readonly Alert[]): Promise<void> {
    for (const alert of alerts) {
      const result = await this.notifier.sendText(alert.text);
      if (!result.ok) {
        this.logger.error(
          `Failed to send alert: ${alert.text} (${result.error.message})`,
        );
      }
    }
  }
}
