import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { JSON_BODY_LIMIT } from "./http-config";

/**
 * M9: the process now listens — `ApiModule` (`src/api/infrastructure`) gives
 * Hermes (a different machine, `CLAUDE.md` §10) a stable HTTP surface, so
 * this switches from `createApplicationContext()` (M8, no HTTP) to a real
 * server. Bound to the Tailscale interface at the container/compose level,
 * not here — this just listens on `API_PORT` inside the container.
 *
 * `enableShutdownHooks()` still wires SIGTERM/SIGINT (Docker's `stop`
 * signal) to Nest's `onModuleDestroy` lifecycle, so `docker compose down`
 * gets a clean stop rather than a hard kill after Compose's grace period —
 * unchanged from M8, now covering the HTTP listener too.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
