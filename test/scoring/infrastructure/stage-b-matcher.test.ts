import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { MatchesRepository } from "../../../src/persistence/infrastructure/matches-repository";
import { Profile } from "../../../src/profile/domain/profile";
import { Requirement } from "../../../src/scoring/domain/types";
import { StageBMatcher } from "../../../src/scoring/infrastructure/stage-b-matcher";

let dir: string;
let db: Db;
let matchesRepo: MatchesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-stage-b-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  matchesRepo = new MatchesRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-14T03:00:00Z");

function profile(): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Built atlas-manager's HTTP layer in Node.js."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    text: "Node.js experience",
    category: "language",
    weight: "mandatory",
    ...overrides,
  };
}

describe("StageBMatcher.match — cache", () => {
  it("calls the model once per requirement and caches the result on a miss", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toEqual([
        {
          requirement: requirement(),
          status: "met",
          evidence: "Built atlas-manager's HTTP layer in Node.js.",
        },
      ]);
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(matchesRepo.find("fp1", "hash1", "b-v2")).toEqual(
      result.ok ? result.matches : null,
    );
  });

  it("never calls the model on a cache hit", async () => {
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v2",
      [{ requirement: requirement(), status: "not_met", evidence: null }],
      NOW,
    );
    const ask = vi.fn(async () => '{"status":"met","evidence":"x"}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("treats a different profileHash as a cache miss (ADR-007)", async () => {
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v2",
      [{ requirement: requirement(), status: "met", evidence: "old" }],
      NOW,
    );
    const ask = vi.fn(async () => '{"status":"not_met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash2",
      () => NOW,
    );

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches[0]?.status).toBe("not_met");
  });

  it("returns matches for multiple requirements, one model call each", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"met","evidence":"x"}')
      .mockResolvedValueOnce('{"status":"not_met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement({ text: "A" }), requirement({ text: "B" })],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.map((m) => m.status)).toEqual(["met", "not_met"]);
    }
  });

  it("returns ok:true with an empty match list, no model calls, for an empty requirement list", async () => {
    const ask = vi.fn(async () => '{"status":"met","evidence":"x"}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, matches: [] });
  });
});

describe("StageBMatcher.match — ADR-005: evidence:null forces not_met", () => {
  it("coerces a met with evidence:null to not_met, ignoring the model's claimed status", async () => {
    const ask = vi.fn(async () => '{"status":"met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("not_met");
      expect(result.matches[0]?.evidence).toBeNull();
    }
  });

  it("coerces a partial with evidence:null to not_met as well", async () => {
    const ask = vi.fn(async () => '{"status":"partial","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches[0]?.status).toBe("not_met");
  });
});

describe("StageBMatcher.match — failure, never throws", () => {
  it("returns ok:false with matching_failed after retries are exhausted, caching nothing", async () => {
    const ask = vi.fn(async () => "not json");
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 3,
    });
    expect(matchesRepo.find("fp1", "hash1", "b-v2")).toBeNull();
  });

  it("discards results for requirements already matched when a later one fails", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"met","evidence":"x"}')
      .mockResolvedValue("not json");
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement({ text: "A" }), requirement({ text: "B" })],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(false);
    expect(matchesRepo.find("fp1", "hash1", "b-v2")).toBeNull();
  });
});
