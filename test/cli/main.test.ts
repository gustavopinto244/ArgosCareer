import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeCollect,
  executeDedup,
  executeDeliver,
  executeIngestExternal,
  executeStudyPlan,
} from "../../src/cli/main";
import { createPosting, Posting } from "../../src/posting/domain/posting";
import { Taxonomy } from "../../src/market/domain/taxonomy";
import { TextNotifier } from "../../src/delivery/infrastructure/telegram-notifier";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";
import {
  RunsRepository,
  parseFailedSources,
  parseTruncatedSources,
} from "../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../src/posting/domain/ports/collector.port";
import { Criteria } from "../../src/prefilter/domain/criteria";
import { Profile } from "../../src/profile/domain/profile";
import { StubScorer } from "../../src/scoring/infrastructure/stub-scorer";
import { ScorerPort } from "../../src/scoring/domain/ports/scorer.port";
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

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

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

    await executeCollect(db, () => collector, [{}], undefined, 0);
    const second = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

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

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

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

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("Gupy responded 500");

    const runsRepo = new RunsRepository(db);
    expect(runsRepo.findById(outcome.runId)?.outcome).toBe("failed");
  });
});

describe("executeCollect — multi-query cycles", () => {
  /** Records each query it is asked for, answering with one posting each. */
  function recordingCollector(errorOn: number[] = []): {
    collector: CollectorPort;
    queries: unknown[];
  } {
    const queries: unknown[] = [];
    return {
      queries,
      collector: {
        collect: async (criteria: unknown): Promise<CollectionResult> => {
          const index = queries.length;
          queries.push(criteria);
          if (errorOn.includes(index)) {
            return {
              source: "gupy",
              collectedAt: new Date(),
              postings: [],
              error: new Error(`query ${index} failed`),
            };
          }
          return {
            source: "gupy",
            collectedAt: new Date(),
            postings: [
              {
                source: "gupy",
                sourceId: String(index),
                payload: gupyPayload(index, `Estágio ${index}`),
              },
            ],
          };
        },
      },
    };
  }

  it("issues every configured query and folds them into ONE run row", async () => {
    const { collector, queries } = recordingCollector();
    const outcome = await executeCollect(
      db,
      () => collector,
      [{ jobName: "estágio", city: "Rio de Janeiro" }, { isRemoteWork: true }],
      undefined,
      0,
    );

    expect(queries).toEqual([
      { jobName: "estágio", city: "Rio de Janeiro" },
      { isRemoteWork: true },
    ]);
    expect(outcome.collected).toBe(2);
    expect(outcome.isNew).toBe(2);

    // One cycle is one run — anything that counts runs (the digest summary,
    // the consecutive-empty-collection alert) depends on this.
    const runs = new RunsRepository(db).findRecent("collect", 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.collectedCount).toBe(2);
  });

  it("keeps what succeeded when one query fails, and stays a success", async () => {
    const { collector } = recordingCollector([0]);
    const outcome = await executeCollect(
      db,
      () => collector,
      [{}, {}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("query 0 failed");
    expect(outcome.isNew).toBe(1); // the surviving query still persisted
    const run = new RunsRepository(db).findById(outcome.runId);
    // Degraded, not down (principle 1): one dead query out of two must not
    // look identical to a dead source, or the collection-health alert fires
    // on a healthy cycle.
    expect(run?.outcome).toBe("success");
  });

  it("marks the run failed only when every query fails", async () => {
    const { collector } = recordingCollector([0, 1]);
    const outcome = await executeCollect(
      db,
      () => collector,
      [{}, {}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("query 0 failed");
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.outcome).toBe("failed");
  });
});

describe("executeCollect — recency window (ADR-019)", () => {
  const WINDOW = { recencyDays: 1, backfillDays: 7 };

  /** Gupy payload carrying an explicit publication date. */
  function datedPayload(
    id: number,
    name: string,
    publishedDate: string | null,
  ) {
    const base = gupyPayload(id, name);
    return publishedDate === null ? base : { ...base, publishedDate };
  }

  function collectorWith(payloads: unknown[]): CollectorPort {
    return {
      collect: async () => ({
        source: "gupy",
        collectedAt: new Date(),
        postings: payloads.map((payload, i) => ({
          source: "gupy",
          sourceId: String(i),
          payload,
        })),
      }),
    };
  }

  it("drops a posting published before the window and keeps a fresh one", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    // Seed a successful collect so this is NOT treated as a first run.
    await executeCollect(
      db,
      () => collectorWith([]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(1, "Estágio Fresco", "2026-08-15T06:00:00Z"),
          datedPayload(2, "Estágio Velho", "2026-07-01T06:00:00Z"),
        ]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(1);
  });

  it("keeps a posting the source never dated — absence is not evidence of age", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    await executeCollect(
      db,
      () => collectorWith([]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    const outcome = await executeCollect(
      db,
      () => collectorWith([datedPayload(3, "Estágio Sem Data", null)]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("uses the wider backfill window when no successful collect exists yet", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    // Four days old: outside recencyDays (1), inside backfillDays (7).
    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(4, "Estágio de 4 dias", "2026-08-11T12:00:00Z"),
        ]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("applies no window at all when none is configured", async () => {
    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(5, "Estágio Antigo", "2020-01-01T00:00:00Z"),
        ]),
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });
});

describe("executeCollect — collector dispatch by source", () => {
  it("routes each query to the collector its source names", async () => {
    const asked: string[] = [];
    const make = (name: string): CollectorPort => ({
      collect: async () => {
        asked.push(name);
        return { source: name, collectedAt: new Date(), postings: [] };
      },
    });
    const registry: Record<string, CollectorPort> = {
      gupy: make("gupy"),
      ciee: make("ciee"),
    };

    await executeCollect(
      db,
      (source) => registry[source] ?? null,
      [{ source: "ciee" }, { source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(asked).toEqual(["ciee", "gupy", "ciee"]);
  });

  it("closes the run as failed when resolving a collector throws", async () => {
    // Collectors themselves cannot throw (principle 1), so the reachable
    // throw inside `executeCollect` is everything around them — resolution,
    // and the database writes. Either way the run row must not be left open;
    // see the matching test for `executeDeliver`.
    await expect(
      executeCollect(
        db,
        () => {
          throw new Error("registry exploded");
        },
        [{ source: "gupy" }],
        undefined,
        0,
      ),
    ).rejects.toThrow("registry exploded");

    const [run] = new RunsRepository(db).findRecent("collect", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
  });

  it("defaults a query with no source to gupy", async () => {
    const asked: string[] = [];
    await executeCollect(
      db,
      (source) => {
        asked.push(source);
        return {
          collect: async () => ({
            source,
            collectedAt: new Date(),
            postings: [],
          }),
        };
      },
      [{ jobName: "estágio" }],
      undefined,
      0,
    );

    expect(asked).toEqual(["gupy"]);
  });

  it("reports an unregistered source rather than dying on a config typo", async () => {
    const outcome = await executeCollect(
      db,
      () => null,
      [{ source: "gupq" }],
      undefined,
      0,
    );

    expect(outcome.error).toContain(
      'No collector registered for source "gupq"',
    );
    expect(outcome.collected).toBe(0);
  });

  it("records the failed source and failure reason on the run row (docs/11 B2)", async () => {
    const outcome = await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "indeed",
          collectedAt: new Date(),
          postings: [],
          error: { message: "Indeed responded 500" },
        }),
      }),
      [{ source: "indeed" }],
      undefined,
      0,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.failureReason).toBe("Indeed responded 500");
    expect(parseFailedSources(run!)).toEqual(["indeed"]);
  });

  it("leaves failedSources empty on the run row when every query succeeds", async () => {
    const outcome = await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "gupy",
          collectedAt: new Date(),
          postings: [],
        }),
      }),
      [{ source: "gupy" }],
      undefined,
      0,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.failureReason).toBeNull();
    expect(parseFailedSources(run!)).toEqual([]);
  });
});

describe("executeCollect — multi-source dispatch", () => {
  it("normalizes each source with its own normalizer in one cycle", async () => {
    // The bug this guards: executeCollect used to call normalizeGupyJob
    // directly, so a second source's payloads were handed to Gupy's schema,
    // failed validation and vanished — indistinguishable from an empty
    // source.
    const collector: CollectorPort = {
      collect: async (criteria) => {
        const which = (criteria as { source?: string }).source;
        return which === "ciee"
          ? {
              source: "ciee",
              collectedAt: new Date(),
              postings: [
                {
                  source: "ciee",
                  sourceId: "9000001",
                  payload: {
                    codigoVaga: 9000001,
                    tipoVaga: "ESTAGIO",
                    nomeEmpresa: "ALFA SERVICOS DIGITAIS LTDA",
                    areaProfissional: "Informática",
                    nivelEscolar: "SU",
                    local: { cidade: "Rio de Janeiro", uf: "RJ" },
                    atividades: ["Atividade exemplo"],
                  },
                },
              ],
            }
          : {
              source: "gupy",
              collectedAt: new Date(),
              postings: [
                {
                  source: "gupy",
                  sourceId: "1",
                  payload: gupyPayload(1, "Estágio em Backend"),
                },
              ],
            };
      },
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{ source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(2);
    expect(outcome.unnormalizable).toBe(0);
    expect(outcome.error).toBeUndefined();

    const titles = new PostingsRepository(db)
      .findActive()
      .map((p) => p.title)
      .sort();
    expect(titles).toEqual(["Estágio em Backend", "Estágio em Informática"]);
  });

  it("reports an unregistered source as a wiring bug, not an empty source", async () => {
    const collector: CollectorPort = {
      collect: async () => ({
        source: "jooble",
        collectedAt: new Date(),
        postings: [
          { source: "jooble", sourceId: "1", payload: { anything: true } },
        ],
      }),
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(0);
    expect(outcome.unnormalizable).toBe(1);
    expect(outcome.error).toContain("No normalizer registered");
  });

  it("counts an item the normalizer rejects as unnormalizable, not silently (docs/audit AC-012)", async () => {
    // The bug this guards: a registered normalizer returning null (as
    // opposed to no normalizer being registered at all) was not counted
    // anywhere on this internal path — executeIngestExternal already
    // counted the equivalent case correctly.
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio válido"),
        },
        // careerPageName empty -> normalizeGupyJob returns null
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Sem empresa", ""),
        },
      ],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.unnormalizable).toBe(1);
    expect(outcome.error).toBeUndefined();

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.unnormalizableCount).toBe(1);
  });

  it("sums receivedCount and schemaRejectedCount across collectors (docs/audit AC-012)", async () => {
    const collector: CollectorPort = {
      collect: async () => ({
        source: "gupy",
        collectedAt: new Date(),
        postings: [
          { source: "gupy", sourceId: "1", payload: gupyPayload(1, "x") },
        ],
        receivedCount: 5,
        schemaRejectedCount: 3,
      }),
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{ source: "gupy" }, { source: "gupy" }],
      undefined,
      0,
    );

    expect(outcome.received).toBe(10);
    expect(outcome.schemaRejected).toBe(6);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.receivedCount).toBe(10);
    expect(run?.schemaRejectedCount).toBe(6);
  });

  it("defaults received/schemaRejected to 0 when a collector does not report them", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.received).toBe(0);
    expect(outcome.schemaRejected).toBe(0);
  });

  it("records which source(s) reported truncation (docs/audit AC-013)", async () => {
    const registry: Record<string, CollectorPort> = {
      gupy: {
        collect: async () => ({
          source: "gupy",
          collectedAt: new Date(),
          postings: [
            { source: "gupy", sourceId: "1", payload: gupyPayload(1, "x") },
          ],
          truncated: true,
        }),
      },
      ciee: {
        collect: async () => ({
          source: "ciee",
          collectedAt: new Date(),
          postings: [],
          truncated: false,
        }),
      },
    };

    const outcome = await executeCollect(
      db,
      (source) => registry[source] ?? null,
      [{ source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(outcome.truncatedSources).toEqual(["gupy"]);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual(["gupy"]);
  });

  it("leaves truncatedSources empty when no collector reports it", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.truncatedSources).toEqual([]);
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual([]);
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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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
      unknownTrackCapScore: 50,
      stageBConcurrency: 8,
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

describe("executeIngestExternal", () => {
  const NOW = new Date("2026-08-16T14:00:00Z");

  /** A minimal, faithful stand-in for `normalizeIndeedJob` — the point of
   * this suite is `executeIngestExternal`'s own loop/bookkeeping, not the
   * real normalizer, which has its own test file. */
  function fakeNormalizer(): {
    normalize: (
      raw: { source: string; sourceId: string; payload: unknown },
      now: Date,
    ) => Posting | null;
    calls: unknown[];
  } {
    const calls: unknown[] = [];
    return {
      calls,
      normalize: (raw, now) => {
        calls.push(raw.payload);
        const payload = raw.payload as { title?: string; company?: string };
        if (!payload.title || !payload.company) return null;
        return createPosting({
          source: raw.source,
          sourceId: raw.sourceId,
          company: payload.company,
          title: payload.title,
          location: { kind: "unknown" },
          workMode: "unknown",
          collectedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
          rawPayload: payload,
        });
      },
    };
  }

  it("normalizes and upserts a batch, recording one 'collect' run", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [
        { sourceId: "in-1", payload: { title: "Estágio A", company: "X" } },
        { sourceId: "in-2", payload: { title: "Estágio B", company: "Y" } },
      ],
      () => NOW,
    );

    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(2);
    expect(outcome.isNew).toBe(2);
    expect(outcome.alreadySeen).toBe(0);
    expect(outcome.unnormalizable).toBe(0);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.kind).toBe("collect");
    expect(run?.outcome).toBe("success");

    const stored = new PostingsRepository(db).findActive();
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.source)).toEqual(["indeed", "indeed"]);
  });

  it("counts an item the normalizer rejects as unnormalizable, not a thrown error", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [
        { sourceId: "in-1", payload: { title: "Estágio A", company: "X" } },
        { sourceId: "in-2", payload: { title: "no company" } }, // rejected
      ],
      () => NOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.unnormalizable).toBe(1);
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.outcome).toBe("success");
  });

  it("re-ingesting the same sourceId upserts rather than duplicating", async () => {
    const { normalize } = fakeNormalizer();
    const first = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );
    expect(first.isNew).toBe(1);

    const second = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );
    expect(second.isNew).toBe(0);
    expect(second.alreadySeen).toBe(1);
    expect(new PostingsRepository(db).findActive()).toHaveLength(1);
  });

  it("closes the run as failed, not orphaned, when the normalizer throws", async () => {
    // Same bookkeeping guarantee executeCollect/executeDeliver already
    // carry (#49) — a throw between start and finish must not leave the
    // row open forever.
    const throwing = () => {
      throw new Error("boom");
    };

    await expect(
      executeIngestExternal(
        db,
        "indeed",
        throwing,
        [{ sourceId: "in-1", payload: {} }],
        () => NOW,
      ),
    ).rejects.toThrow("boom");

    const [run] = new RunsRepository(db).findRecent("collect", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
  });
});

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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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

  it("persists OpenRouter usage onto the run row when getUsage is provided (docs/audit AC-015)", async () => {
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
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();
    const getUsage = () => ({
      calls: 3,
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 10,
      costUsd: 0.0042,
      attempts: 4,
      attemptsByOutcome: {
        success: 3,
        httpError: 1,
        timeout: 0,
        networkError: 0,
        invalidEnvelope: 0,
        invalidOutput: 0,
      },
      attemptsWithoutUsage: 1,
    });

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
      getUsage,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.llmAttempts).toBe(4);
    expect(run?.llmCostUsd).toBeCloseTo(0.0042);
    expect(run?.llmAttemptsWithoutUsage).toBe(1);
  });

  it("leaves llm usage columns at 0 when no getUsage is provided (the stub-adapter path)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.llmAttempts).toBe(0);
    expect(run?.llmCostUsd).toBe(0);
  });

  it("closes the run as failed when the scorer throws, instead of leaving it open forever", async () => {
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
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const { notifier } = recordingNotifier();
    // `ScorerPort` forbids this (ADR-006), and on 2026-08-16 `ApiScorer` did
    // it anyway: a prompt template missing from the image threw straight
    // through. What matters here is not the throw but the bookkeeping — the
    // run row must not survive as `finishedAt: null`, which `/health` reads
    // as "still running" and `findLatestFinished` skips.
    const throwingScorer: ScorerPort = {
      score: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };

    await expect(
      executeDeliver(db, throwingScorer, notifier, criteria, deliverProfile()),
    ).rejects.toThrow("ENOENT");

    const runsRepo = new RunsRepository(db);
    const [run] = runsRepo.findRecent("scoreAndDeliver", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
    // The pre-filter had already passed one posting before the throw; the
    // row records that rather than flattening the run to zeroes.
    expect(run?.filteredCount).toBe(1);
    expect(run?.scoredCount).toBe(0);
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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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
    await executeCollect(db, () => collector, [{}], undefined, 0);
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

  it("reports the real failed source, not a hardcoded guess (docs/11 B2)", async () => {
    // Regression test: this summary used to hardcode ["gupy"] for any
    // failed collect run in the window, regardless of which source it
    // actually was.
    await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "indeed",
          collectedAt: new Date(),
          postings: [],
          error: { message: "Indeed responded 500" },
        }),
      }),
      [{ source: "indeed" }],
      undefined,
      0,
    );

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    await executeDeliver(db, scorer, notifier, criteria, deliverProfile());

    expect(digests[0]?.summary.failedSources).toEqual(["indeed"]);
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
    await executeCollect(db, () => collector, [{}], undefined, 0);

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
