import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { JSON_BODY_LIMIT } from "../../../src/http-config";
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
import { RunLock } from "../../../src/scheduling/domain/run-lock";
import { RUN_LOCK } from "../../../src/scheduling/infrastructure/run-lock.provider";

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
let app: NestExpressApplication;
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
    .useValue(() => fakeCollector)
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
  app = moduleRef.createNestApplication<NestExpressApplication>();
  // Same limit `main.ts`'s real bootstrap applies (JSON_BODY_LIMIT) —
  // applied here too so the suite's default 100kb body limit cannot hide a
  // regression of the real one (the exact bug the Indeed collector's first
  // production run hit — see the "large payload" test below).
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
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

function gupyPayload(id: number, name: string, careerPageName = "Empresa X") {
  return { id, name, careerPageName };
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

  it("dispatches each configured query to the collector its own source names, not always Gupy (docs/audit AC-003)", async () => {
    // Regression test for AC-003: the REST provider used to hardcode a
    // single GupyCollector regardless of query.source, so config/criteria.yaml's
    // real ciee/solides queries were silently sent through Gupy. Two
    // distinguishable fakes, resolved by source exactly like
    // `collectorFor` does in production, prove each source reaches its own
    // adapter.
    class TaggedFakeCollector implements CollectorPort {
      readonly calls: unknown[] = [];
      constructor(private readonly source: string) {}
      async collect(criteria: unknown): Promise<CollectionResult> {
        this.calls.push(criteria);
        return { source: this.source, postings: [], collectedAt: new Date() };
      }
    }
    const gupyFake = new TaggedFakeCollector("gupy");
    const cieeFake = new TaggedFakeCollector("ciee");
    const solidesFake = new TaggedFakeCollector("solides");
    const resolver = (source: string): CollectorPort | null =>
      ({ gupy: gupyFake, ciee: cieeFake, solides: solidesFake })[source] ??
      null;

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(COLLECTOR)
      .useValue(resolver)
      .overrideProvider(NOTIFIER)
      .useValue(fakeNotifier)
      .overrideProvider(CRITERIA)
      .useValue({
        ...loadCriteria("./config/criteria.yaml"),
        collection: {
          queries: [
            { source: "gupy" },
            { source: "ciee" },
            { source: "solides" },
          ],
          queryIntervalMs: 0,
          recencyDays: 1,
          backfillDays: 7,
        },
      })
      .compile();
    const dispatchApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    await dispatchApp.init();

    try {
      const res = await auth(
        request(dispatchApp.getHttpServer()).post("/runs/collect").send({}),
      );
      expect(res.status).toBe(201);
      expect(gupyFake.calls).toHaveLength(1);
      expect(cieeFake.calls).toHaveLength(1);
      expect(solidesFake.calls).toHaveLength(1);
    } finally {
      await dispatchApp.close();
    }
  });

  it("reports a configured query for an unregistered source as a wiring bug, via the real registry (docs/audit AC-003)", async () => {
    // Uses collectorFor (the real production registry) rather than a fake,
    // so this also proves the REST wiring resolves by source at all — the
    // exact thing AC-003 found missing — not just that a fake responds.
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(NOTIFIER)
      .useValue(fakeNotifier)
      .overrideProvider(CRITERIA)
      .useValue({
        ...loadCriteria("./config/criteria.yaml"),
        collection: {
          queries: [{ source: "not-a-real-source" }],
          queryIntervalMs: 0,
          recencyDays: 1,
          backfillDays: 7,
        },
      })
      .compile();
    const realRegistryApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    await realRegistryApp.init();

    try {
      const res = await auth(
        request(realRegistryApp.getHttpServer()).post("/runs/collect").send({}),
      );
      expect(res.status).toBe(201);
      expect(res.body.collected).toBe(0);
      expect(res.body.error).toContain(
        'No collector registered for source "not-a-real-source"',
      );
    } finally {
      await realRegistryApp.close();
    }
  });
});

describe("POST /runs/collect/external (ADR-027)", () => {
  it("requires auth, same as every other route", async () => {
    await request(app.getHttpServer())
      .post("/runs/collect/external")
      .expect(401);
  });

  it("requires 'source'", async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({ postings: [{ sourceId: "1", payload: {} }] }),
    );
    expect(res.status).toBe(400);
  });

  it("requires 'postings' to be an array", async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({ source: "gupy", postings: "not an array" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unregistered source before opening a run row", async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({
          source: "no-such-source",
          postings: [{ sourceId: "1", payload: {} }],
        }),
    );
    expect(res.status).toBe(400);
    expect(new RunsRepository(db).findRecent("collect", 10)).toHaveLength(0);
  });

  it("rejects an empty postings array", async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({ source: "gupy", postings: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("normalizes real gupy-shaped payloads and writes a 'collect' run", async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({
          source: "gupy",
          postings: [
            { sourceId: "1", payload: gupyPayload(1, "Estágio Externo") },
          ],
        }),
    );

    expect(res.status).toBe(201);
    expect(res.body.normalized).toBe(1);
    expect(res.body.isNew).toBe(1);

    const run = new RunsRepository(db).findById(res.body.runId);
    expect(run?.kind).toBe("collect");
    expect(run?.outcome).toBe("success");
  });

  it("shares the 'collect' RunLock with POST /runs/collect (ADR-024) — rejected while one is in flight", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fakeCollector.collect = async (criteria: unknown) => {
      fakeCollector.calls.push(criteria);
      await gate;
      return { source: "fake", postings: [], collectedAt: new Date() };
    };

    const first = auth(
      request(app.getHttpServer()).post("/runs/collect").send({}),
    ).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({
          source: "gupy",
          postings: [{ sourceId: "1", payload: gupyPayload(1, "X") }],
        }),
    );
    expect(second.status).toBe(409);

    releaseFirst();
    await first;
  });

  it("accepts a batch well over Express's 100kb default — the Indeed collector's first real run hit this exact 413", async () => {
    // A single real Indeed posting's description alone was enough to blow
    // past the framework default; padding one field to ~300kb reproduces
    // that with a self-contained fixture instead of a real large payload.
    const bigDescription = "x".repeat(300_000);
    const postings = Array.from({ length: 5 }, (_, i) => ({
      sourceId: `in-${i}`,
      payload: {
        ...gupyPayload(i, "Estágio Grande", "Empresa Grande"),
        description: bigDescription,
      },
    }));

    const res = await auth(
      request(app.getHttpServer())
        .post("/runs/collect/external")
        .send({ source: "gupy", postings }),
    );

    expect(res.status).not.toBe(413);
    expect(res.status).toBe(201);
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

describe("overlap guard (ADR-024)", () => {
  it("dedup: rejects with 409 while a dedup run is already marked in flight", async () => {
    const runLock = app.get<RunLock>(RUN_LOCK);
    runLock.tryAcquire("dedup");

    try {
      const res = await auth(request(app.getHttpServer()).post("/runs/dedup"));
      expect(res.status).toBe(409);
    } finally {
      runLock.release("dedup");
    }

    // Freed afterward — a locked-out call is rejected, not left stuck.
    const res = await auth(request(app.getHttpServer()).post("/runs/dedup"));
    expect(res.status).toBe(201);
  });

  it("collect: a second call while the first is still running is rejected, not queued or corrupted", async () => {
    // Holds the collector call open until the test releases it, so a
    // concurrently-fired second request can observe the lock actually held
    // by a real in-flight run rather than racing a call that resolves
    // before the assertion runs.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fakeCollector.collect = async (criteria: unknown) => {
      fakeCollector.calls.push(criteria);
      await gate;
      return { source: "fake", postings: [], collectedAt: new Date() };
    };

    // supertest's `Test` does not actually send until something calls
    // `.then()` on it — holding the bare chain in a variable sends nothing.
    // `.then((res) => res)` starts the request without blocking here.
    const first = auth(
      request(app.getHttpServer()).post("/runs/collect").send({}),
    ).then((res) => res);
    // Yield to the event loop so `first`'s handler has actually acquired
    // the lock before `second` fires — both requests are real HTTP calls
    // against the same running app, not two calls into the same function.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await auth(
      request(app.getHttpServer()).post("/runs/collect").send({}),
    );
    expect(second.status).toBe(409);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.status).toBe(201);

    // Not stuck afterward.
    const third = await auth(
      request(app.getHttpServer()).post("/runs/collect").send({}),
    );
    expect(third.status).toBe(201);
  });

  it("deliver: a second call while the first is still sending is rejected — the incident this exists for", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fakeNotifier.notify = async (digest: Digest) => {
      fakeNotifier.sent.push(digest);
      await gate;
      return { ok: true };
    };

    const first = auth(request(app.getHttpServer()).post("/runs/deliver")).then(
      (res) => res,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await auth(
      request(app.getHttpServer()).post("/runs/deliver"),
    );
    expect(second.status).toBe(409);
    // The second call never composed or sent a second digest.
    expect(fakeNotifier.sent).toHaveLength(1);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.status).toBe(201);
  });
});
