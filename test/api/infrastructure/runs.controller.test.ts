import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ApiModule } from "../../../src/api/infrastructure/api.module";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { RunsRepository } from "../../../src/persistence/infrastructure/runs-repository";

const API_KEY = "test-api-key-for-suite";

let dir: string;
let app: INestApplication;
let db: Db;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-api-"));
  env = { ...process.env };
  process.env.DATABASE_PATH = join(dir, "argos.db");
  process.env.API_KEY = API_KEY;

  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule],
  }).compile();
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
