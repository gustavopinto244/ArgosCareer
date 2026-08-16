import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api-key.guard";
import { collectorProvider } from "./collector.provider";
import {
  criteriaProvider,
  profileProvider,
  taxonomyProvider,
} from "./config.provider";
import { databaseProvider } from "./database.provider";
import { MarketController } from "./market.controller";
import { MarketService } from "./market.service";
import { McpController } from "./mcp.controller";
import { notifierProvider } from "./notifier.provider";
import { PostingsController } from "./postings.controller";
import { PostingsService } from "./postings.service";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { runLockProvider } from "../../scheduling/infrastructure/run-lock.provider";

/**
 * M9: the HTTP surface Hermes (a different machine, `CLAUDE.md` §10)
 * reaches over Tailscale — REST (`RunsController`) and MCP
 * (`McpController`), both thin over the one `RunsService`. `ApiKeyGuard`
 * registered as `APP_GUARD` — global, not per-controller — so a controller
 * added later is authenticated by default rather than by remembering to
 * add `@UseGuards`; that includes `/mcp`, MCP-over-HTTP is still HTTP.
 * `COLLECTOR` and `NOTIFIER` are factory providers, not `new
 * GupyCollector()`/`new TelegramNotifier()` inline, specifically so tests
 * can override them and the stage re-execution paths never make a real
 * network call in the suite.
 *
 * `runLockProvider` (ADR-024) is imported from `scheduling/infrastructure`
 * rather than duplicated here — it and `SchedulingModule`'s copy resolve
 * `RUN_LOCK` to the same exported singleton, so `RunsService`'s REST/MCP
 * stage triggers and `SchedulerService`'s cron ticks guard each other.
 */
@Module({
  controllers: [
    RunsController,
    MarketController,
    PostingsController,
    McpController,
  ],
  providers: [
    databaseProvider,
    collectorProvider,
    notifierProvider,
    criteriaProvider,
    profileProvider,
    taxonomyProvider,
    RunsService,
    MarketService,
    PostingsService,
    runLockProvider,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class ApiModule {}
