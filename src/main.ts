import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * Nothing is wired yet — this proves the module graph resolves. Real
 * behavior (scheduler, HTTP) arrives as M8 and M9 add their modules.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.close();
}

void bootstrap();
