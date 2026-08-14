import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { ExtractionsRepository } from "../../../src/persistence/infrastructure/extractions-repository";
import { StageAExtractor } from "../../../src/scoring/infrastructure/stage-a-extractor";

let dir: string;
let db: Db;
let extractionsRepo: ExtractionsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-stage-a-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  extractionsRepo = new ExtractionsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-14T03:00:00Z");

function posting() {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    description: "Buscamos estagiário com conhecimento em Node.js.",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
}

describe("StageAExtractor.extract", () => {
  it("calls the model and caches the result on a cache miss", async () => {
    const ask = vi.fn(async () =>
      JSON.stringify([
        { text: "Node.js", category: "language", weight: "mandatory" },
      ]),
    );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements).toEqual([
        { text: "Node.js", category: "language", weight: "mandatory" },
      ]);
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(extractionsRepo.find(posting().fingerprint, "a-v1")).toEqual([
      { text: "Node.js", category: "language", weight: "mandatory" },
    ]);
  });

  it("never calls the model on a cache hit", async () => {
    extractionsRepo.upsert(
      posting().fingerprint,
      "a-v1",
      [{ text: "SQL", category: "database", weight: "desirable" }],
      NOW,
    );
    const ask = vi.fn(async () => "[]");
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements).toEqual([
        { text: "SQL", category: "database", weight: "desirable" },
      ]);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("returns ok:false with extraction_failed after the model exhausts its retries, never throwing", async () => {
    const ask = vi.fn(async () => "not json");
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 3,
    });
  });

  it("passes an empty array through as a valid extraction — a vague posting is not a failure", async () => {
    const ask = vi.fn(async () => "[]");
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({ ok: true, requirements: [] });
  });
});
