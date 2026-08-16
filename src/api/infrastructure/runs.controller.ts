import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ExternalRawPosting } from "../../cli/main";
import { CollectParams, RunsService } from "./runs.service";

export interface IngestExternalBody {
  readonly source?: string;
  readonly postings?: readonly ExternalRawPosting[];
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
  collect(@Body() body: CollectParams = {}) {
    return this.runs.collect(body);
  }

  @Post("runs/dedup")
  dedup() {
    return this.runs.dedup();
  }

  @Post("runs/deliver")
  deliver() {
    return this.runs.deliver();
  }

  /**
   * ADR-027 — the host-side jobspy script's only entry point. `source` and
   * `postings` are required at this layer (a plain shape check, not a Zod
   * schema — `RawPosting.payload` is deliberately `unknown`, validated
   * tolerantly downstream by whichever normalizer the `source` resolves to,
   * the same boundary Gupy/CIEE's own payloads cross).
   */
  @Post("runs/collect/external")
  collectExternal(@Body() body: IngestExternalBody = {}) {
    if (!body.source) {
      throw new BadRequestException("'source' is required");
    }
    if (!Array.isArray(body.postings)) {
      throw new BadRequestException("'postings' must be an array");
    }
    return this.runs.ingestExternal(body.source, body.postings);
  }
}
