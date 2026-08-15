import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeCollect,
  executeDedup,
  executeDeliver,
  executeStudyPlan,
} from "../../src/cli/main";
import { Taxonomy } from "../../src/market/domain/taxonomy";
import { TextNotifier } from "../../src/delivery/infrastructure/telegram-notifier";
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
import { Criteria } from "../../src/prefilter/domain/criteria";
import { Profile } from "../../src/profile/domain/profile";
import { StubScorer } from "../../src/scoring/infrastructure/stub-scorer";
import { Digest } from "../../src/delivery/domain/digest";
import {
  NotifierPort,
  NotifyResult,
} from "../../src/delivery/domain/ports/notifier.port";

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

function deliverCriteria(): Criteria {
  return {
    titleBlocklist: [],
    titleRequired: ["estágio"],
    location: { cities: [], allowRemote: true },
    blockedCompanies: [],
    minKeywordAdherence: 0,
    tracks: { dev: ["backend"], security: [], automation: [] },
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
    },
  };
}

function deliverProfile(): Profile {
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
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

/** Records every digest it receives instead of sending anything. */
function recordingNotifier(result: NotifyResult = { ok: true }): {
  notifier: NotifierPort;
  digests: Digest[];
} {
  const digests: Digest[] = [];
  return {
    digests,
    notifier: {
      notify: async (digest: Digest) => {
        digests.push(digest);
        return result;
      },
    },
  };
}

describe("executeDeliver", () => {
  it("takes an unnotified posting end to end: pre-filter, score, digest, notify, mark notified", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.filtered).toBe(1);
    expect(outcome.scored).toBe(1);
    expect(outcome.delivered).toBe(1);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.review).toHaveLength(1);

    const postingsRepo = new PostingsRepository(db);
    const [posting] = postingsRepo.findActive();
    expect(posting?.company).toBe("Empresa X");

    const runsRepo = new RunsRepository(db);
    const run = runsRepo.findById(outcome.runId);
    expect(run?.outcome).toBe("success");
    expect(run?.deliveredCount).toBe(1);
  });

  it("never notifies the same posting twice (ADR-007) — a second run finds nothing to deliver", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);

    const first = await executeDeliver(
      db,
      scorer,
      recordingNotifier().notifier,
      criteria,
      deliverProfile(),
    );
    const { notifier: secondNotifier, digests } = recordingNotifier();
    const second = await executeDeliver(
      db,
      scorer,
      secondNotifier,
      criteria,
      deliverProfile(),
    );

    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(digests[0]?.review).toHaveLength(0);
  });

  it("does not mark a posting notified when the notifier fails", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier({
      ok: false,
      error: { message: "Telegram unreachable" },
    });

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBe("Telegram unreachable");

    const runsRepo = new RunsRepository(db);
    expect(runsRepo.findById(outcome.runId)?.outcome).toBe("failed");

    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findUnnotified()).toHaveLength(1);
  });

  it("excludes a posting that fails the pre-filter from scoring and the digest", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Analista Pleno de Backend"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.filtered).toBe(0);
    expect(outcome.scored).toBe(0);
    expect(outcome.delivered).toBe(0);
    expect(digests[0]?.review).toHaveLength(0);
  });

  it("reports collected and deduplicated counts from collect/dedup runs since the last delivery", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Estágio em Backend (Rio de Janeiro)"),
        },
      ],
    });
    await executeCollect(db, collector, {});
    executeDedup(db);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBeUndefined();
    expect(digests[0]?.summary.collected).toBe(2);
    expect(digests[0]?.summary.failedSources).toEqual([]);
  });
});

const studyPlanTaxonomy: Taxonomy = {
  skills: [{ canonical: "PostgreSQL", aliases: ["Postgres"] }],
};

/** Records every text send instead of hitting the network. */
function recordingTextNotifier(): { notifier: TextNotifier; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notifier: {
      sendText: async (text: string) => {
        sent.push(text);
        return { ok: true };
      },
    },
  };
}

describe("executeStudyPlan", () => {
  it("sends a study plan built from the current corpus, over the active database only", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, collector, {});

    const { notifier, sent } = recordingTextNotifier();
    const outcome = await executeStudyPlan(
      db,
      deliverCriteria(),
      deliverProfile(),
      studyPlanTaxonomy,
      notifier,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.delivered).toBe(true);
    expect(outcome.corpusSize).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Corpus: 1 vagas");
  });

  it("reports a delivery failure without throwing", async () => {
    const notifier: TextNotifier = {
      sendText: async () => ({
        ok: false,
        error: { message: "Telegram is down" },
      }),
    };

    const outcome = await executeStudyPlan(
      db,
      deliverCriteria(),
      deliverProfile(),
      studyPlanTaxonomy,
      notifier,
    );

    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBe("Telegram is down");
  });
});
