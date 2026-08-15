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
import { CRITERIA } from "../../../src/api/infrastructure/config.provider";
import { loadCriteria } from "../../../src/prefilter/infrastructure/criteria-loader";
import { Digest } from "../../../src/delivery/domain/digest";
import {
  NotifierPort,
  NotifyResult,
} from "../../../src/delivery/domain/ports/notifier.port";
import { TextNotifier } from "../../../src/delivery/infrastructure/telegram-notifier";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { RunsRepository } from "../../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../../src/posting/domain/ports/collector.port";

const API_KEY = "test-api-key-for-suite";

/**
 * No real Gupy request in this suite — `COLLECTOR` is overridden with this
 * fake for every test (`docs/07-testing-strategy.md`: no real network call).
 */
class FakeCollector implements CollectorPort {
  readonly calls: unknown[] = [];

  async collect(criteria: unknown): Promise<CollectionResult> {
    this.calls.push(criteria);
    return { source: "fake", postings: [], collectedAt: new Date() };
  }
}

/** No real Telegram request in this suite — `NOTIFIER` is overridden with
 * this fake for every test, same reasoning as `FakeCollector`. Implements
 * `TextNotifier` too (M10): `NOTIFIER` now backs both `RunsService.deliver`
 * and `MarketService.studyPlan`. */
class FakeNotifier implements NotifierPort, TextNotifier {
  readonly sent: Digest[] = [];
  readonly sentText: string[] = [];

  async notify(digest: Digest): Promise<NotifyResult> {
    this.sent.push(digest);
    return { ok: true };
  }

  async sendText(text: string): Promise<NotifyResult> {
    this.sentText.push(text);
    return { ok: true };
  }
}

let dir: string;
let app: INestApplication;
let db: Db;
let env: NodeJS.ProcessEnv;
let fakeCollector: FakeCollector;
let fakeNotifier: FakeNotifier;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-api-"));
  env = { ...process.env };
  process.env.DATABASE_PATH = join(dir, "argos.db");
  process.env.API_KEY = API_KEY;
  // /runs/deliver's buildScorer reads this — stub needs no LLM_API_KEY/model
  // and makes no network call, matching the fakes above for the same reason.
  process.env.SCORER_ADAPTER = "stub";
  // config/profile.yaml is gitignored and may not exist in this environment
  // at all; the committed, fictional example is schema-valid and enough for
  // this suite (CRITERIA_PATH stays at its default — config/criteria.yaml
  // is committed and real).
  process.env.PROFILE_PATH = "./config/profile.example.yaml";

  fakeCollector = new FakeCollector();
  fakeNotifier = new FakeNotifier();

  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule],
  })
    .overrideProvider(COLLECTOR)
    .useValue(fakeCollector)
    .overrideProvider(NOTIFIER)
    .useValue(fakeNotifier)
    // Real criteria, but no politeness sleep: the configured cycle issues
    // several queries and the suite must not spend real seconds waiting
    // between them (docs/07-testing-strategy.md).
    .overrideProvider(CRITERIA)
    .useValue({
      ...loadCriteria("./config/criteria.yaml"),
      collection: {
        ...loadCriteria("./config/criteria.yaml").collection,
        queryIntervalMs: 0,
      },
    })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();

  // A second connection to the same file (safe under WAL — db.ts), used only
  // to seed `runs` rows the controller under test then reads back.
  db = createDatabase(process.env.DATABASE_PATH);
  runMigrations(db);
});

afterEach(async () => {
  await app.close();
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function auth(req: request.Test): request.Test {
  return req.set("Authorization", `Bearer ${API_KEY}`);
}

describe("ApiKeyGuard", () => {
  it("rejects a request with no Authorization header", async () => {
    await request(app.getHttpServer()).get("/health").expect(401);
  });

  it("rejects a malformed Authorization header (no Bearer prefix)", async () => {
    await request(app.getHttpServer())
      .get("/health")
      .set("Authorization", API_KEY)
      .expect(401);
  });

  it("rejects the wrong key", async () => {
    await request(app.getHttpServer())
      .get("/health")
      .set("Authorization", "Bearer wrong-key")
      .expect(401);
  });

  it("rejects a key that is a prefix of the real one (length-sensitive check)", async () => {
    await request(app.getHttpServer())
      .get("/health")
      .set("Authorization", `Bearer ${API_KEY.slice(0, 5)}`)
      .expect(401);
  });

  it("accepts the correct key", async () => {
    await auth(request(app.getHttpServer()).get("/health")).expect(200);
  });
});

describe("GET /health", () => {
  it("reports null for every kind when nothing has ever run", async () => {
    const res = await auth(request(app.getHttpServer()).get("/health"));
    expect(res.body).toEqual({
      lastSuccessfulRun: { collect: null, dedup: null, scoreAndDeliver: null },
    });
  });

  it("reports the most recent successful run per kind, and nothing else", async () => {
    const repo = new RunsRepository(db);
    const runId = repo.start("collect", new Date("2026-08-15T10:00:00Z"));
    repo.finish(runId, new Date("2026-08-15T10:01:00Z"), "success", {
      collectedCount: 5,
    });
    // A failed run must not surface as the "last successful" one.
    const failedId = repo.start("collect", new Date("2026-08-15T11:00:00Z"));
    repo.finish(failedId, new Date("2026-08-15T11:01:00Z"), "failed");

    const res = await auth(request(app.getHttpServer()).get("/health"));
    expect(res.body.lastSuccessfulRun.collect).toEqual({
      runId,
      finishedAt: "2026-08-15T10:01:00.000Z",
    });
    expect(res.body.lastSuccessfulRun.dedup).toBeNull();
    // Structural only — no posting titles/descriptions in this payload at all.
    expect(JSON.stringify(res.body)).not.toContain("collectedCount");
  });
});

describe("GET /runs", () => {
  it("requires a kind query parameter", async () => {
    const res = await auth(request(app.getHttpServer()).get("/runs"));
    expect(res.status).toBe(400);
  });

  it("returns an empty list for a kind with no runs", async () => {
    const res = await auth(
      request(app.getHttpServer()).get("/runs?kind=collect"),
    );
    expect(res.body).toEqual({ runs: [] });
  });

  it("returns runs of the requested kind, newest first, respecting limit", async () => {
    const repo = new RunsRepository(db);
    const first = repo.start("collect", new Date("2026-08-15T10:00:00Z"));
    repo.finish(first, new Date("2026-08-15T10:01:00Z"), "success");
    const second = repo.start("collect", new Date("2026-08-15T11:00:00Z"));
    repo.finish(second, new Date("2026-08-15T11:01:00Z"), "success");
    // A different kind must never appear in the "collect" list.
    const otherKind = repo.start("dedup", new Date("2026-08-15T12:00:00Z"));
    repo.finish(otherKind, new Date("2026-08-15T12:01:00Z"), "success");

    const res = await auth(
      request(app.getHttpServer()).get("/runs?kind=collect&limit=1"),
    );
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].runId).toBe(second);
  });

  it("rejects a non-positive-integer limit", async () => {
    const res = await auth(
      request(app.getHttpServer()).get("/runs?kind=collect&limit=abc"),
    );
    expect(res.status).toBe(400);
  });

  it("caps an excessive limit rather than erroring", async () => {
    const res = await auth(
      request(app.getHttpServer()).get("/runs?kind=collect&limit=999999"),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /runs/:runId", () => {
  it("returns the run when it exists", async () => {
    const repo = new RunsRepository(db);
    const runId = repo.start("deliver", new Date("2026-08-15T10:00:00Z"));
    repo.finish(runId, new Date("2026-08-15T10:01:00Z"), "success");

    const res = await auth(request(app.getHttpServer()).get(`/runs/${runId}`));
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });

  it("returns 404 for an unknown runId", async () => {
    await auth(request(app.getHttpServer()).get("/runs/does-not-exist")).expect(
      404,
    );
  });
});

describe("POST /runs/collect", () => {
  it("requires auth, same as every other route", async () => {
    await request(app.getHttpServer()).post("/runs/collect").expect(401);
  });

  it("runs the configured collection cycle when the body is empty", async () => {
    const configured = loadCriteria("./config/criteria.yaml").collection.queries
      .length;
    const res = await auth(
      request(app.getHttpServer()).post("/runs/collect").send({}),
    );

    expect(res.status).toBe(201);
    // One call per configured query, folded into a single run row.
    expect(fakeCollector.calls).toHaveLength(configured);
    const repo = new RunsRepository(db);
    const run = repo.findById(res.body.runId);
    expect(run?.kind).toBe("collect");
    expect(run?.outcome).toBe("success");
  });

  it("passes the request body through to the collector as collect params", async () => {
    await auth(
      request(app.getHttpServer())
        .post("/runs/collect")
        .send({ jobName: "estagio", city: "Rio de Janeiro", maxResults: 10 }),
    );

    expect(fakeCollector.calls[0]).toEqual({
      jobName: "estagio",
      city: "Rio de Janeiro",
      maxResults: 10,
    });
  });
});

describe("POST /runs/dedup", () => {
  it("requires auth", async () => {
    await request(app.getHttpServer()).post("/runs/dedup").expect(401);
  });

  it("runs dedup and writes a real run", async () => {
    const res = await auth(request(app.getHttpServer()).post("/runs/dedup"));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      runId: expect.any(String),
      scanned: 0,
      markedDuplicate: 0,
    });
    const repo = new RunsRepository(db);
    expect(repo.findById(res.body.runId)?.kind).toBe("dedup");
  });
});

describe("POST /runs/deliver", () => {
  it("requires auth", async () => {
    await request(app.getHttpServer()).post("/runs/deliver").expect(401);
  });

  it("scores with the stub scorer, sends through the injected notifier, writes a real run", async () => {
    const res = await auth(request(app.getHttpServer()).post("/runs/deliver"));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      runId: expect.any(String),
      filtered: 0,
      scored: 0,
      delivered: 0,
    });
    // Even a digest with nothing to report is still sent — the run summary
    // itself is the everyday signal (docs/08-observability.md).
    expect(fakeNotifier.sent).toHaveLength(1);
    const repo = new RunsRepository(db);
    const run = repo.findById(res.body.runId);
    expect(run?.kind).toBe("scoreAndDeliver");
    expect(run?.outcome).toBe("success");
  });

  it("fails with a named reason when the scorer is misconfigured", async () => {
    process.env.SCORER_ADAPTER = "api"; // no LLM_API_KEY set
    const res = await auth(request(app.getHttpServer()).post("/runs/deliver"));

    expect(res.status).toBe(400);
    expect(fakeNotifier.sent).toHaveLength(0);
  });
});
