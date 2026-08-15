import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { ...process.env };
  // ApiKeyGuard (M9) reads this eagerly in its constructor — fails at
  // startup rather than lazily (docs/09-configuration.md rule 1) — so
  // compiling the graph at all needs it set, same as any other required
  // config this module tree depends on.
  process.env.API_KEY = "test-key-for-module-graph-compile";
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
