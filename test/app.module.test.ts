import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { ...process.env };
  // ApiKeyGuard and the M9 config/notifier providers all read their
  // requirements eagerly at construction (docs/09-configuration.md rule 1:
  // fail at startup, never lazily) — compiling the graph at all needs every
  // one of them set. PROFILE_PATH points at the committed, fictional
  // example file (`config/profile.yaml` itself is gitignored and may not
  // exist in this environment) — CRITERIA_PATH is left at its default since
  // `config/criteria.yaml` is committed and real.
  process.env.API_KEY = "test-key-for-module-graph-compile";
  process.env.TELEGRAM_BOT_TOKEN = "000:test";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.PROFILE_PATH = "./config/profile.example.yaml";
});

afterEach(() => {
  process.env = env;
});

describe("AppModule", () => {
  it("compiles the module graph", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
