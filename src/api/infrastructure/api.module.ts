import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api-key.guard";
import { collectorProvider } from "./collector.provider";
import { criteriaProvider, profileProvider } from "./config.provider";
import { databaseProvider } from "./database.provider";
import { notifierProvider } from "./notifier.provider";
import { RunsController } from "./runs.controller";

/**
 * M9: the HTTP surface Hermes (a different machine, `CLAUDE.md` §10)
 * reaches over Tailscale. `ApiKeyGuard` registered as `APP_GUARD` — global,
 * not per-controller — so a controller added later is authenticated by
 * default rather than by remembering to add `@UseGuards`. `COLLECTOR` and
 * `NOTIFIER` are factory providers, not `new GupyCollector()`/
 * `new TelegramNotifier()` inline in the controller, specifically so tests
 * can override them and the stage re-execution endpoints never make a real
 * network call in the suite.
 */
@Module({
  controllers: [RunsController],
  providers: [
    databaseProvider,
    collectorProvider,
    notifierProvider,
    criteriaProvider,
    profileProvider,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class ApiModule {}
