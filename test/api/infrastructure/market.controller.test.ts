import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ApiModule } from "../../../src/api/infrastructure/api.module";
import { COLLECTOR } from "../../../src/api/infrastructure/collector.provider";
import { NOTIFIER } from "../../../src/api/infrastructure/notifier.provider";
import {
  NotifierPort,
  NotifyResult,
} from "../../../src/delivery/domain/ports/notifier.port";
import { TextNotifier } from "../../../src/delivery/infrastructure/telegram-notifier";
import {
  CollectionResult,
  CollectorPort,
} from "../../../src/posting/domain/ports/collector.port";

const API_KEY = "test-api-key-for-market-suite";

class FakeCollector implements CollectorPort {
  async collect(): Promise<CollectionResult> {
    return { source: "fake", postings: [], collectedAt: new Date() };
  }
}

/** No real Telegram request in this suite — same reasoning as
 * runs.controller.test.ts's FakeNotifier. */
class FakeNotifier implements NotifierPort, TextNotifier {
  readonly sentText: string[] = [];
  async notify(): Promise<NotifyResult> {
    return { ok: true };
  }
  async sendText(text: string): Promise<NotifyResult> {
    this.sentText.push(text);
    return { ok: true };
  }
}

let dir: string;
let app: INestApplication;
let env: NodeJS.ProcessEnv;
let fakeNotifier: FakeNotifier;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-market-api-"));
  env = { ...process.env };
  process.env.DATABASE_PATH = join(dir, "argos.db");
  process.env.API_KEY = API_KEY;
  process.env.SCORER_ADAPTER = "stub";
  process.env.PROFILE_PATH = "./config/profile.example.yaml";

  fakeNotifier = new FakeNotifier();

  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule],
  })
    .overrideProvider(COLLECTOR)
    .useValue(() => new FakeCollector())
    .overrideProvider(NOTIFIER)
    .useValue(fakeNotifier)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterEach(async () => {
  await app.close();
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function auth(req: request.Test): request.Test {
  return req.set("Authorization", `Bearer ${API_KEY}`);
}

describe("POST /market/study-plan", () => {
  it("rejects an unauthenticated request", async () => {
    await request(app.getHttpServer()).post("/market/study-plan").expect(401);
  });

  it("generates and sends a study plan over an empty corpus", async () => {
    const response = await auth(
      request(app.getHttpServer()).post("/market/study-plan"),
    ).expect(201);

    expect(response.body).toMatchObject({
      corpusSize: 0,
      extractedCount: 0,
      highCompatibilityCount: 0,
      gapCount: 0,
      delivered: true,
    });
    expect(fakeNotifier.sentText).toHaveLength(1);
    expect(fakeNotifier.sentText[0]).toContain("Corpus: 0 vagas");
  });
});
