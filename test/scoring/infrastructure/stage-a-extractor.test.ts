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
import { hashExtractionInput } from "../../../src/scoring/domain/extraction-input-hash";
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
      JSON.stringify({
        requirements: [
          { text: "Node.js", category: "language", weight: "mandatory" },
        ],
        seniority: "internship",
        experienceYears: null,
      }),
    );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: true,
      requirements: [
        // `verifiable` defaulted to true: the mock above omits it, and
        // omission must not be able to delete a requirement (ADR-015).
        {
          text: "Node.js",
          category: "language",
          weight: "mandatory",
          verifiable: true,
        },
      ],
      seniority: "internship",
      experienceYears: null,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(
      extractionsRepo.find(
        posting().fingerprint,
        "a-v3",
        hashExtractionInput(posting().title, posting().description),
      ),
    ).toEqual({
      requirements: [
        {
          text: "Node.js",
          category: "language",
          weight: "mandatory",
          verifiable: true,
        },
      ],
      seniority: "internship",
      experienceYears: null,
    });
  });

  it("never calls the model on a cache hit", async () => {
    extractionsRepo.upsert(
      posting().fingerprint,
      "a-v3",
      hashExtractionInput(posting().title, posting().description),
      {
        requirements: [
          { text: "SQL", category: "database", weight: "desirable" },
        ],
        seniority: "trainee",
        experienceYears: 1,
      },
      NOW,
    );
    const ask = vi.fn(async () =>
      JSON.stringify({
        requirements: [],
        seniority: null,
        experienceYears: null,
      }),
    );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: true,
      requirements: [
        { text: "SQL", category: "database", weight: "desirable" },
      ],
      seniority: "trainee",
      experienceYears: 1,
    });
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
    const ask = vi.fn(async () =>
      JSON.stringify({
        requirements: [],
        seniority: null,
        experienceYears: null,
      }),
    );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: true,
      requirements: [],
      seniority: null,
      experienceYears: null,
    });
  });

  it("rejects an invented seniority value, treating it like any other schema failure", async () => {
    const ask = vi.fn(
      async () =>
        '{"requirements":[],"seniority":"principal","experienceYears":null}',
    );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 3,
    });
  });

  it("re-extracts when the description changes, even though the fingerprint stays identical (docs/audit AC-006)", async () => {
    // The real scenario: a company edits a posting's description (adds
    // "inglês avançado") without touching company/title/city, so
    // computeFingerprint (ADR-007: company+title+city only) produces the
    // same value it always did. Previously the cache keyed only on
    // (fingerprint, promptVersion) and kept serving the extraction of the
    // OLD description forever.
    const ask = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          requirements: [
            { text: "Node.js", category: "language", weight: "mandatory" },
          ],
          seniority: null,
          experienceYears: null,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          requirements: [
            { text: "Node.js", category: "language", weight: "mandatory" },
            {
              text: "Inglês avançado",
              category: "language",
              weight: "mandatory",
            },
          ],
          seniority: null,
          experienceYears: null,
        }),
      );
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const original = posting();
    const first = await extractor.extract(original, () => NOW);
    expect(ask).toHaveBeenCalledTimes(1);
    if (first.ok) expect(first.requirements).toHaveLength(1);

    // Same fingerprint (createPosting derives it from company+title+city
    // only), different description.
    const updated = {
      ...original,
      description: `${original.description} Inglês avançado necessário.`,
    };
    expect(updated.fingerprint).toBe(original.fingerprint);

    const second = await extractor.extract(updated, () => NOW);
    expect(ask).toHaveBeenCalledTimes(2);
    if (second.ok) {
      expect(second.requirements).toHaveLength(2);
      expect(second.requirements.map((r) => r.text)).toContain(
        "Inglês avançado",
      );
    }
  });
});

/**
 * Four of the sixteen hand-labelled calibration postings had no description
 * at all (ADR-014). Asking the model to extract requirements from nothing
 * spends a call to be told what the caller already knows, and — worse —
 * caching that empty answer kept being served after the text was recovered.
 */
describe("StageAExtractor.extract — posting with no description", () => {
  function descriptionless(description: string | null) {
    return createPosting({
      source: "gupy",
      sourceId: "2",
      company: "Empresa Y",
      title: "Estágio - Service Desk",
      description,
      location: { kind: "known", city: "Rio de Janeiro" },
      workMode: "hybrid",
      collectedAt: NOW,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      rawPayload: {},
    });
  }

  it("returns an empty extraction without calling the model", async () => {
    const ask = vi.fn(async () => "{}");
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(descriptionless(null), () => NOW);

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      requirements: [],
      seniority: null,
      experienceYears: null,
    });
  });

  it("treats a whitespace-only description the same way", async () => {
    const ask = vi.fn(async () => "{}");
    const extractor = new StageAExtractor(ask, extractionsRepo);

    await extractor.extract(descriptionless("   \n  "), () => NOW);

    expect(ask).not.toHaveBeenCalled();
  });

  it("does not cache the empty result, so recovered text re-extracts", async () => {
    const ask = vi.fn(async () => "{}");
    const extractor = new StageAExtractor(ask, extractionsRepo);
    const p = descriptionless(null);

    await extractor.extract(p, () => NOW);

    expect(
      extractionsRepo.find(
        p.fingerprint,
        "a-v3",
        hashExtractionInput(p.title, p.description),
      ),
    ).toBeNull();
  });
});

describe("when the prompt template cannot be read", () => {
  // The real 2026-08-16 condition: the template is absent from the process's
  // view of the filesystem. `ApiScorer`'s docblock promises a failure at
  // either stage "returns as a value, never throws", and before this it did
  // throw — out of the scoring loop and past `runsRepo.finish`.
  it("returns a typed failure with attempts 0 rather than throwing", async () => {
    const original = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "argos-no-prompts-"));
    const ask = vi.fn();

    try {
      process.chdir(empty);
      const extractor = new StageAExtractor(ask, extractionsRepo);
      const result = await extractor.extract(posting());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("extraction_failed");
        // Literal: a template that never loaded means the model was never
        // asked, so no attempt was spent and none should be reported.
        expect(result.attempts).toBe(0);
      }
      expect(ask).not.toHaveBeenCalled();
    } finally {
      process.chdir(original);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
