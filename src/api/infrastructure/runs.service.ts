import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  executeCollect,
  executeDedup,
  executeDeliver,
  executeIngestExternal,
  ExternalRawPosting,
} from "../../cli/main";
import { normalizerFor } from "../../posting/infrastructure/normalizer-registry";
import { NotifierPort } from "../../delivery/domain/ports/notifier.port";
import { Db } from "../../persistence/infrastructure/db";
import {
  RunRow,
  RunsRepository,
} from "../../persistence/infrastructure/runs-repository";
import { Criteria } from "../../prefilter/domain/criteria";
import { CollectorPort } from "../../posting/domain/ports/collector.port";
import { Profile } from "../../profile/domain/profile";
import { buildScorer } from "../../scoring/infrastructure/build-scorer";
import { RunLock, runExclusive } from "../../scheduling/domain/run-lock";
import { RUN_LOCK } from "../../scheduling/infrastructure/run-lock.provider";
import { COLLECTOR } from "./collector.provider";
import { CRITERIA, PROFILE } from "./config.provider";
import { DATABASE } from "./database.provider";
import { NOTIFIER } from "./notifier.provider";

/** The three run kinds ADR-009's two crons (plus dedup, folded into the
 * collection cycle) actually produce — `docs/08-observability.md`'s health
 * endpoint spec, made concrete. Not a general enum: `RunsRepository.kind`
 * stays a free string (new stages get new kinds without a schema change),
 * this is just which three `health()` reports on. */
const RUN_KINDS = ["collect", "dedup", "scoreAndDeliver"] as const;
type RunKind = (typeof RUN_KINDS)[number];

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

export interface CollectParams {
  // `| undefined` explicit, not just `?:` — the MCP tool handler passes a
  // Zod-parsed object straight through, and `z.optional()`'s output type is
  // `T | undefined`, which `exactOptionalPropertyTypes` treats as distinct
  // from a merely-absent property.
  readonly jobName?: string | undefined;
  readonly city?: string | undefined;
  readonly maxResults?: number | undefined;
}

/**
 * The one implementation of every run-inspection query and every stage
 * trigger (M9) — `RunsController` (REST) and `McpController` (MCP tools)
 * both call this, not two copies of "how do I run collect" that could
 * quietly drift apart. `BadRequestException`/`NotFoundException` are
 * NestJS's, thrown here rather than in the controller: they are plain
 * `Error` subclasses with a `.message` and work outside an HTTP request
 * context too (`McpController` catches them and reads `.message` for the
 * tool's error text; a NestJS exception filter does the same translation
 * to a status code automatically for the REST path).
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(COLLECTOR) private readonly collector: CollectorPort,
    @Inject(NOTIFIER) private readonly notifier: NotifierPort,
    @Inject(CRITERIA) private readonly criteria: Criteria,
    @Inject(PROFILE) private readonly profile: Profile,
    @Inject(RUN_LOCK) private readonly runLock: RunLock,
  ) {}

  /**
   * `docs/08-observability.md`: "an HTTP health endpoint reporting last
   * successful run per kind, which is what an external check — including
   * Hermes — can poll." Verbatim.
   */
  health() {
    const repo = new RunsRepository(this.db);
    const perKind = Object.fromEntries(
      RUN_KINDS.map((kind) => [
        kind,
        summarize(repo.findLatestFinished(kind, "success")),
      ]),
    ) as Record<RunKind, ReturnType<typeof summarize>>;
    return { lastSuccessfulRun: perKind };
  }

  list(kind: string | undefined, limitParam: string | number | undefined) {
    if (!kind) {
      throw new BadRequestException("'kind' is required");
    }
    const limit = parseLimit(limitParam);
    const repo = new RunsRepository(this.db);
    return { runs: repo.findRecent(kind, limit) };
  }

  detail(runId: string): RunRow {
    const repo = new RunsRepository(this.db);
    const run = repo.findById(runId);
    if (!run) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    return run;
  }

  /**
   * Stage re-execution (M9) — the same `executeCollect`/`executeDedup`/
   * `executeDeliver` the CLI's `collect`/`dedup`/`deliver` commands and
   * `SchedulerService`'s cron handlers already call. One code path for
   * "run this stage" regardless of what triggered it (principle 2), now
   * proven a fourth way (CLI, scheduler, REST, MCP).
   */
  /**
   * ADR-024: rejects with 409 (`ConflictException`) rather than starting a
   * second `collect` on top of one already running — the scheduler's own
   * 4-hourly tick is the most likely thing to collide with a manual call,
   * not another manual call racing itself.
   */
  async collect(params: CollectParams) {
    // An empty body means "run the configured cycle", the same thing the
    // cron does; a body with any field set is a deliberate one-off query
    // and overrides the configuration rather than adding to it.
    const isAdHoc = Object.values(params).some((v) => v !== undefined);
    const queries = isAdHoc ? [params] : this.criteria.collection.queries;
    const outcome = await runExclusive(this.runLock, "collect", () =>
      executeCollect(
        this.db,
        () => this.collector,
        queries,
        () => new Date(),
        this.criteria.collection.queryIntervalMs,
        this.criteria.collection,
      ),
    );
    if (!outcome.ok) {
      throw new ConflictException("collect is already running");
    }
    return outcome.result;
  }

  /** Same guard as `collect` — see ADR-024. */
  async dedup() {
    const outcome = await runExclusive(this.runLock, "dedup", () =>
      Promise.resolve(executeDedup(this.db)),
    );
    if (!outcome.ok) {
      throw new ConflictException("dedup is already running");
    }
    return outcome.result;
  }

  /**
   * Real, on demand: a genuine scoring pass (real API spend unless
   * `SCORER_ADAPTER=stub`) and a genuine Telegram send — exactly what the
   * nightly cron does, callable early. This is the intended capability
   * ("Hermes can ask for a check now"), not a footgun — documented in the
   * M9 ADR, not hidden here.
   *
   * Guarded (ADR-024) against the concrete incident that motivated it: a
   * manual `POST /runs/deliver` landing while the scheduled cycle's own
   * multi-hour run was still scoring — two runs racing the same
   * `findUnnotified()` candidate pool can score the same postings twice and
   * send two overlapping digests to Telegram before either marks anything
   * notified.
   */
  async deliver() {
    const built = buildScorer(this.db, this.criteria, this.profile);
    if (!built.ok) {
      throw new BadRequestException(`Misconfigured scorer: ${built.error}`);
    }
    const outcome = await runExclusive(this.runLock, "scoreAndDeliver", () =>
      executeDeliver(
        this.db,
        built.scorer,
        this.notifier,
        this.criteria,
        this.profile,
        built.getUsage,
      ),
    );
    if (!outcome.ok) {
      throw new ConflictException("scoreAndDeliver is already running");
    }
    return outcome.result;
  }

  /**
   * ADR-027: the receiving end of a source that fetches outside this
   * process entirely — jobspy, run from a host-side script in an ephemeral
   * container, never inside this container (no Docker socket mounted here,
   * deliberately). The host script is the only intended caller; there is no
   * MCP tool for this, since it is a machine-to-machine ingest path, not a
   * capability Hermes has any reason to invoke.
   *
   * Shares the `collect` `RunLock` kind with `collect()` above (ADR-024) —
   * an external ingest racing the scheduled Gupy/CIEE cycle is the same
   * class of problem that guard already exists for.
   */
  async ingestExternal(
    source: string,
    postings: readonly ExternalRawPosting[],
  ) {
    const normalize = normalizerFor(source);
    if (!normalize) {
      throw new BadRequestException(
        `No normalizer registered for source "${source}"`,
      );
    }
    if (postings.length === 0) {
      throw new BadRequestException("'postings' must not be empty");
    }

    const outcome = await runExclusive(this.runLock, "collect", () =>
      executeIngestExternal(this.db, source, normalize, postings),
    );
    if (!outcome.ok) {
      throw new ConflictException("collect is already running");
    }
    return outcome.result;
  }
}

function summarize(run: { runId: string; finishedAt: Date | null } | null) {
  if (!run) return null;
  return { runId: run.runId, finishedAt: run.finishedAt };
}

function parseLimit(raw: string | number | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException("'limit' must be a positive integer");
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}
