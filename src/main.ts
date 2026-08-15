import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * M8: the process now has a reason to stay up — `SchedulerService`'s cron
 * jobs. No `app.close()` here; the process runs until the container stops
 * it. `enableShutdownHooks()` wires SIGTERM/SIGINT (Docker's `stop` signal)
 * to Nest's `onModuleDestroy` lifecycle, so `docker compose down` gets a
 * clean stop rather than a hard kill after Compose's grace period.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void bootstrap();
