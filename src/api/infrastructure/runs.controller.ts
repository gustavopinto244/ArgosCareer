import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { ExternalRawPosting } from "../../cli/main";
import { principalFromRequest } from "./auth-principal";
import { CollectParams, RunsService } from "./runs.service";

export interface IngestExternalBody {
  readonly source?: string;
  readonly postings?: readonly ExternalRawPosting[];
  /** Set by the caller when it hit its own configured cap this run
   * (docs/audit PR-015) — jobspy's `results_wanted`, or Catho's
   * `MAX_PAGES_PER_RUN`. This process never sees the source's raw
   * response, so it can only carry forward what the caller already
   * knows. */
  readonly truncated?: boolean;
}

/**
 * Read-only run inspection and stage re-execution (M9), thin over
 * `RunsService` — the same service `McpController`'s tools call, so the
 * two surfaces can never implement "run collect" two different ways.
 * Every response is structural (run IDs, counts, timestamps, outcomes) —
 * never a posting's title or description, the same boundary
 * `docs/08-observability.md` already draws around log lines, drawn here
 * for the first surface a network consumer reads.
 */
@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get("health")
  health() {
    return this.runs.health();
  }

  @Get("runs")
  list(@Query("kind") kind?: string, @Query("limit") limit?: string) {
    return this.runs.list(kind, limit);
  }

  @Get("runs/:runId")
  detail(@Param("runId") runId: string) {
    return this.runs.detail(runId);
  }

  @Post("runs/collect")
  collect(@Req() request: Request, @Body() body: CollectParams = {}) {
    return this.runs.collect(body, principalFromRequest(request).id);
  }

  @Post("runs/dedup")
  dedup(@Req() request: Request) {
    return this.runs.dedup(principalFromRequest(request).id);
  }

  @Post("runs/deliver")
  deliver(@Req() request: Request) {
    return this.runs.deliver(principalFromRequest(request).id);
  }

  /** docs/11-known-issues.md C1. `kind` in the path, not a fixed route,
   * even though only `scoreAndDeliver` is accepted today — `RunsService`
   * is where that restriction is enforced (and explained), and a fixed
   * `runs/scoreAndDeliver/cancel` route would just move the same check
   * into routing without changing what a caller can actually do. */
  @Post("runs/:kind/cancel")
  cancel(@Param("kind") kind: string) {
    return this.runs.cancel(kind);
  }

  /**
   * ADR-027 — the host-side jobspy script's only entry point. `source` and
   * `postings` are required at this layer (a plain shape check, not a Zod
   * schema — `RawPosting.payload` is deliberately `unknown`, validated
   * tolerantly downstream by whichever normalizer the `source` resolves to,
   * the same boundary Gupy/CIEE's own payloads cross).
   */
  @Post("runs/collect/external")
  collectExternal(
    @Req() request: Request,
    @Body() body: IngestExternalBody = {},
  ) {
    if (!body.source) {
      throw new BadRequestException("'source' is required");
    }
    if (!Array.isArray(body.postings)) {
      throw new BadRequestException("'postings' must be an array");
    }
    return this.runs.ingestExternal(
      body.source,
      body.postings,
      body.truncated ?? false,
      principalFromRequest(request).id,
    );
  }
}
