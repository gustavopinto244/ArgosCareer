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
import { MatchesRepository } from "../../../src/persistence/infrastructure/matches-repository";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { Profile } from "../../../src/profile/domain/profile";
import { ApiScorer } from "../../../src/scoring/infrastructure/api-scorer";
import { StageAExtractor } from "../../../src/scoring/infrastructure/stage-a-extractor";
import { StageBMatcher } from "../../../src/scoring/infrastructure/stage-b-matcher";

let dir: string;
let db: Db;
let extractionsRepo: ExtractionsRepository;
let matchesRepo: MatchesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-api-scorer-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  extractionsRepo = new ExtractionsRepository(db);
  matchesRepo = new MatchesRepository(db);
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

function criteria(): Criteria {
  return {
    titleBlocklist: [],
    titleRequired: ["estágio"],
    location: { cities: [], allowRemote: true },
    blockedCompanies: [],
    minKeywordAdherence: 0,
    tracks: { dev: ["backend"], security: [], automation: [] },
    trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
    },
  };
}

function profile(): Profile {
  return {
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
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

describe("ApiScorer.score", () => {
  it("runs extraction then matching then stage C, and classifies the track deterministically", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { text: "Node.js", category: "language", weight: "mandatory" },
        ]),
      )
      .mockResolvedValueOnce(
        '{"status":"met","evidence":"Built a Node.js service."}',
      );

    const extractor = new StageAExtractor(ask, extractionsRepo);
    const matcher = new StageBMatcher(ask, matchesRepo);
    const scorer = new ApiScorer(extractor, matcher, profile(), criteria());

    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.breakdown.mandatoryCoverage).toBe(1);
      expect(result.breakdown.trackAlignment).toBe(1.0);
      expect(result.lowConfidence).toBe(false);
    }
  });

  it("returns ok:false with the extraction failure reason without calling the matcher", async () => {
    const ask = vi.fn(async () => "not json");
    const matchSpy = vi.spyOn(StageBMatcher.prototype, "match");

    const extractor = new StageAExtractor(ask, extractionsRepo);
    const matcher = new StageBMatcher(ask, matchesRepo);
    const scorer = new ApiScorer(extractor, matcher, profile(), criteria());

    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 3,
    });
    expect(matchSpy).not.toHaveBeenCalled();
    matchSpy.mockRestore();
  });

  it("returns ok:false with the matching failure reason", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { text: "Node.js", category: "language", weight: "mandatory" },
        ]),
      )
      .mockResolvedValue("not json");

    const extractor = new StageAExtractor(ask, extractionsRepo);
    const matcher = new StageBMatcher(ask, matchesRepo);
    const scorer = new ApiScorer(extractor, matcher, profile(), criteria());

    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 3,
    });
  });

  it("caps the verdict at review with lowConfidence when extraction returns nothing", async () => {
    const ask = vi.fn(async () => "[]");
    const extractor = new StageAExtractor(ask, extractionsRepo);
    const matcher = new StageBMatcher(ask, matchesRepo);
    const scorer = new ApiScorer(extractor, matcher, profile(), criteria());

    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lowConfidence).toBe(true);
      expect(result.verdict).not.toBe("apply");
    }
  });
});
