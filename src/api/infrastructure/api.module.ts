import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api-key.guard";
import { databaseProvider } from "./database.provider";
import { RunsController } from "./runs.controller";

/**
 * M9: the HTTP surface Hermes (a different machine, `CLAUDE.md` §10)
 * reaches over Tailscale. `ApiKeyGuard` registered as `APP_GUARD` — global,
 * not per-controller — so a controller added later is authenticated by
 * default rather than by remembering to add `@UseGuards`.
 */
@Module({
  controllers: [RunsController],
  providers: [databaseProvider, { provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class ApiModule {}
