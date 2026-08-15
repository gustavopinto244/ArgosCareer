import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CollectParams, RunsService } from "./runs.service";

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
}
