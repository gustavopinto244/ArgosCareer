import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { Db } from "../../persistence/infrastructure/db";
import { RunsRepository } from "../../persistence/infrastructure/runs-repository";
import { DATABASE } from "./database.provider";

/** The three run kinds ADR-009's two crons (plus dedup, folded into the
 * collection cycle) actually produce — `docs/08-observability.md`'s health
 * endpoint spec, made concrete. Not a general enum: `RunsRepository.kind`
 * stays a free string (new stages get new kinds without a schema change),
 * this is just which three `GET /health` reports on. */
const RUN_KINDS = ["collect", "dedup", "scoreAndDeliver"] as const;
type RunKind = (typeof RUN_KINDS)[number];

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

/**
 * Read-only run inspection (M9) — the same `RunsRepository` the scheduler
 * and CLI already use, exposed over HTTP so Hermes (a different machine,
 * `CLAUDE.md` §10) can poll status without SSH. Every response is
 * structural (run IDs, counts, timestamps, outcomes) — never a posting's
 * title or description, the same boundary `docs/08-observability.md`
 * already draws around log lines, drawn here for the first surface a
 * network consumer reads.
 */
@Controller()
export class RunsController {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * `docs/08-observability.md`: "an HTTP health endpoint reporting last
   * successful run per kind, which is what an external check — including
   * Hermes — can poll." Verbatim.
   */
  @Get("health")
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

  @Get("runs")
  list(@Query("kind") kind?: string, @Query("limit") limitParam?: string) {
    if (!kind) {
      throw new BadRequestException("query parameter 'kind' is required");
    }
    const limit = parseLimit(limitParam);
    const repo = new RunsRepository(this.db);
    return { runs: repo.findRecent(kind, limit) };
  }

  @Get("runs/:runId")
  detail(@Param("runId") runId: string) {
    const repo = new RunsRepository(this.db);
    const run = repo.findById(runId);
    if (!run) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    return run;
  }
}

function summarize(run: { runId: string; finishedAt: Date | null } | null) {
  if (!run) return null;
  return { runId: run.runId, finishedAt: run.finishedAt };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIST_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(
      "query parameter 'limit' must be a positive integer",
    );
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}
