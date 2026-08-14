import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCollect, executeDedup } from "../../src/cli/main";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../src/posting/domain/ports/collector.port";

// No test makes a real network call (docs/07-testing-strategy.md) — the
// collector is a stub, never GupyCollector.

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-cli-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubCollector(result: CollectionResult): CollectorPort {
  return { collect: async () => result };
}

function gupyPayload(id: number, name: string, careerPageName = "Empresa X") {
  return { id, name, careerPageName };
}

describe("executeCollect", () => {
  it("normalizes and upserts every valid posting, recording a successful run", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
        { source: "gupy", sourceId: "2", payload: gupyPayload(2, "Estágio B") },
      ],
    });

    const outcome = await executeCollect(db, collector, {});

    expect(outcome.error).toBeUndefined();
    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(2);
    expect(outcome.isNew).toBe(2);
    expect(outcome.alreadySeen).toBe(0);

    const runsRepo = new RunsRepository(db);
    const run = runsRepo.findById(outcome.runId);
    expect(run?.outcome).toBe("success");
    expect(run?.newCount).toBe(2);
  });

  it("reports already-seen postings on a second run over the same source data", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
      ],
    });

    await executeCollect(db, collector, {});
    const second = await executeCollect(db, collector, {});

    expect(second.isNew).toBe(0);
    expect(second.alreadySeen).toBe(1);
  });

  it("skips a normalize failure without failing the whole run", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
        { source: "gupy", sourceId: "2", payload: { nothingUseful: true } },
      ],
    });

    const outcome = await executeCollect(db, collector, {});

    expect(outcome.error).toBeUndefined();
    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(1);
  });

  it("records a failed run and returns the error when the collector itself fails, never throwing", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
      error: { message: "Gupy responded 500" },
    });

    const outcome = await executeCollect(db, collector, {});

    expect(outcome.error).toBe("Gupy responded 500");

    const runsRepo = new RunsRepository(db);
    expect(runsRepo.findById(outcome.runId)?.outcome).toBe("failed");
  });
});

describe("executeDedup", () => {
  it("scans the corpus and records a run without touching a collector", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio Back-End"),
        },
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Estágio Back End (Rio de Janeiro)"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const outcome = executeDedup(db);

    expect(outcome.scanned).toBe(2);
    expect(outcome.markedDuplicate).toBe(1);

    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findActive()).toHaveLength(1);
  });

  it("is independently re-runnable — a second run over an unchanged corpus marks nothing new", () => {
    const first = executeDedup(db);
    const second = executeDedup(db);

    expect(first.scanned).toBe(0);
    expect(second.markedDuplicate).toBe(0);
  });
});
