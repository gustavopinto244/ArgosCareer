import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { ExtractionsRepository } from "../../../src/persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../../src/persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { createPosting } from "../../../src/posting/domain/posting";
import { MarketRepository } from "../../../src/market/infrastructure/market-repository";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
} from "../../../src/scoring/infrastructure/prompts";
import {
  createMatch,
  Match,
  Requirement,
} from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");
const PROFILE_HASH = "hash1";

function criteria(): Criteria {
  return {
    collection: {
      queries: [{ source: "gupy" }],
      queryIntervalMs: 0,
      recencyDays: 1,
      backfillDays: 7,
    },
    titleBlocklist: [],
    titleRequired: ["estágio"],
    location: { cities: [], allowRemote: true },
    blockedCompanies: [],
    minKeywordAdherence: 0,
    maxAgeDays: null,
    undatedBacklogCutoverAt: null,
    maxFutureSkewDays: 1,
    tracks: { dev: ["backend"], security: ["segurança"], automation: [] },
    trackExclusions: { dev: [], security: [], automation: [] },
    schedule: {
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    },
    alerts: {
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
    },
    trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
      unknownTrackCapScore: 50,
      stageBConcurrency: 8,
    },
  };
}

function posting(
  sourceId: string,
  company = "Acme",
  title = "Estágio Backend",
) {
  return createPosting({
    source: "gupy",
    sourceId,
    company,
    title,
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "remote",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
}

function requirement(text: string): Requirement {
  return { text, category: "language", weight: "mandatory" };
}

function metMatch(text: string): Match {
  return createMatch(requirement(text), "met", "Evidence.");
}

let dir: string;
let db: ReturnType<typeof createDatabase>;
let postingsRepo: PostingsRepository;
let extractionsRepo: ExtractionsRepository;
let matchesRepo: MatchesRepository;
let repository: MarketRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-market-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  postingsRepo = new PostingsRepository(db);
  extractionsRepo = new ExtractionsRepository(db);
  matchesRepo = new MatchesRepository(db);
  repository = new MarketRepository(db, criteria());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MarketRepository.loadCorpus", () => {
  it("includes a posting with no extraction, with empty requirements and a null verdict", () => {
    postingsRepo.upsert(posting("1"));

    const [entry] = repository.loadCorpus(PROFILE_HASH);
    expect(entry?.requirements).toEqual([]);
    expect(entry?.matches).toBeNull();
    expect(entry?.verdict).toBeNull();
  });

  it("attaches cached requirements from the current prompt version", () => {
    const p = posting("1");
    postingsRepo.upsert(p);
    extractionsRepo.upsert(
      p.fingerprint,
      STAGE_A_PROMPT_VERSION,
      {
        requirements: [requirement("Node.js")],
        seniority: null,
        experienceYears: null,
      },
      NOW,
    );

    const [entry] = repository.loadCorpus(PROFILE_HASH);
    expect(entry?.requirements).toEqual([requirement("Node.js")]);
  });

  it("ignores extractions cached under a superseded prompt version", () => {
    const p = posting("1");
    postingsRepo.upsert(p);
    extractionsRepo.upsert(
      p.fingerprint,
      "a-v0-superseded",
      {
        requirements: [requirement("Node.js")],
        seniority: null,
        experienceYears: null,
      },
      NOW,
    );

    const [entry] = repository.loadCorpus(PROFILE_HASH);
    expect(entry?.requirements).toEqual([]);
  });

  it("recomputes a real verdict from cached matches, the same as ApiScorer's Stage C", () => {
    const p = posting("1");
    postingsRepo.upsert(p);
    extractionsRepo.upsert(
      p.fingerprint,
      STAGE_A_PROMPT_VERSION,
      {
        requirements: [requirement("Node.js")],
        seniority: null,
        experienceYears: null,
      },
      NOW,
    );
    matchesRepo.upsert(
      p.fingerprint,
      PROFILE_HASH,
      STAGE_B_PROMPT_VERSION,
      [metMatch("Node.js")],
      NOW,
    );

    const [entry] = repository.loadCorpus(PROFILE_HASH);
    expect(entry?.verdict).not.toBeNull();
    expect(["apply", "review", "discard"]).toContain(entry?.verdict);
  });

  it("excludes a posting flagged as a similarity duplicate", () => {
    const canonical = posting("1");
    const duplicate = posting("2", "Acme", "Estágio Backend Jr");
    postingsRepo.upsert(canonical);
    postingsRepo.upsert(duplicate);
    postingsRepo.markDuplicate(duplicate.fingerprint, canonical.fingerprint);

    const corpus = repository.loadCorpus(PROFILE_HASH);
    expect(corpus).toHaveLength(1);
    expect(corpus[0]?.posting.fingerprint).toBe(canonical.fingerprint);
  });

  it("ignores matches cached under a different profile hash", () => {
    const p = posting("1");
    postingsRepo.upsert(p);
    matchesRepo.upsert(
      p.fingerprint,
      "a-different-hash",
      STAGE_B_PROMPT_VERSION,
      [metMatch("Node.js")],
      NOW,
    );

    const [entry] = repository.loadCorpus(PROFILE_HASH);
    expect(entry?.matches).toBeNull();
    expect(entry?.verdict).toBeNull();
  });
});
