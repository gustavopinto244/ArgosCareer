import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

describe("AppModule", () => {
  it("compiles the module graph", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
