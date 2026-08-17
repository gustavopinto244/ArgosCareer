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
import { LlmTransportError } from "../../../src/scoring/infrastructure/openrouter-client";
import {
  DEFAULT_MAX_DESCRIPTION_CHARS,
  MAX_REQUIREMENT_TEXT_CHARS,
  StageAExtractor,
} from "../../../src/scoring/infrastructure/stage-a-extractor";

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
      inputTruncated: false,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(
      extractionsRepo.find(
        posting().fingerprint,
        "a-v4",
        "unknown",
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
      "a-v4",
      "unknown",
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
      inputTruncated: false,
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
      permanent: false,
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
      inputTruncated: false,
    });
  });

  it("marks the failure permanent when the underlying cause is a permanent transport error (docs/audit PR-007)", async () => {
    const ask = vi.fn(async () => {
      throw new LlmTransportError("revoked key", "authError");
    });
    const extractor = new StageAExtractor(ask, extractionsRepo);

    const result = await extractor.extract(posting(), () => NOW);

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 1,
      permanent: true,
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
      permanent: false,
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

  it("does not reuse a cached extraction produced by a different model (docs/audit AC-007)", async () => {
    const ask = vi.fn(async () =>
      JSON.stringify({
        requirements: [
          { text: "Node.js", category: "language", weight: "mandatory" },
        ],
        seniority: null,
        experienceYears: null,
      }),
    );
    const extractorA = new StageAExtractor(
      ask,
      extractionsRepo,
      "a-v3",
      "model-a",
    );
    const extractorB = new StageAExtractor(
      ask,
      extractionsRepo,
      "a-v3",
      "model-b",
    );

    await extractorA.extract(posting(), () => NOW);
    expect(ask).toHaveBeenCalledTimes(1);

    // Same fingerprint, same prompt version, same content -- only the
    // model differs. Switching LLM_MODEL must not silently reuse the
    // other model's extraction as if it were this one's.
    await extractorB.extract(posting(), () => NOW);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  describe("docs/audit AC-017 — bounded and sanitized input", () => {
    it("strips HTML markup from title and description before they reach the prompt or the cache key", async () => {
      let prompt = "";
      const ask = vi.fn(async (p: string) => {
        prompt = p;
        return JSON.stringify({
          requirements: [],
          seniority: null,
          experienceYears: null,
        });
      });
      const extractor = new StageAExtractor(ask, extractionsRepo);
      const richPosting = {
        ...posting(),
        description:
          "<p>Buscamos <strong>estagiário</strong></p><ul><li>Node.js</li></ul>",
      };

      await extractor.extract(richPosting, () => NOW);

      expect(prompt).not.toContain("<p>");
      expect(prompt).not.toContain("<strong>");
      expect(prompt).toContain("estagiário");
      expect(prompt).toContain("- Node.js");

      // The cache row must be addressable by the same normalized-text hash
      // a plain-text posting with equivalent content would produce -- the
      // markup itself must not become part of the cache identity.
      const plainTextEquivalent = "Buscamos estagiário\n\n- Node.js";
      expect(
        extractionsRepo.find(
          richPosting.fingerprint,
          "a-v4",
          "unknown",
          hashExtractionInput(richPosting.title, plainTextEquivalent),
        ),
      ).not.toBeNull();
    });

    it("truncates an oversized description, flags inputTruncated, and hashes/prompts the truncated text", async () => {
      let prompt = "";
      const ask = vi.fn(async (p: string) => {
        prompt = p;
        return JSON.stringify({
          requirements: [],
          seniority: null,
          experienceYears: null,
        });
      });
      // A tiny budget makes the boundary reachable without a 12,000-char
      // fixture -- `maxDescriptionChars` is a constructor parameter
      // precisely so this is testable without the production default.
      const extractor = new StageAExtractor(
        ask,
        extractionsRepo,
        "a-v3",
        "unknown",
        20,
      );
      const longPosting = {
        ...posting(),
        description: "Requisito um. Requisito dois. Requisito três longo.",
      };

      const result = await extractor.extract(longPosting, () => NOW);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.inputTruncated).toBe(true);
      expect(prompt).not.toContain("três longo");
    });

    it("does not flag inputTruncated when the description fits the budget", async () => {
      const ask = vi.fn(async () =>
        JSON.stringify({
          requirements: [],
          seniority: null,
          experienceYears: null,
        }),
      );
      const extractor = new StageAExtractor(ask, extractionsRepo);

      const result = await extractor.extract(posting(), () => NOW);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.inputTruncated).toBe(false);
    });

    it("rejects an extraction with more requirements than the configured ceiling", async () => {
      const requirement = {
        text: "Node.js",
        category: "language",
        weight: "mandatory",
      };
      const ask = vi.fn(async () =>
        JSON.stringify({
          requirements: Array.from({ length: 3 }, () => requirement),
          seniority: null,
          experienceYears: null,
        }),
      );
      // A ceiling of 2 makes the 3-element response above over budget.
      const extractor = new StageAExtractor(
        ask,
        extractionsRepo,
        "a-v3",
        "unknown",
        DEFAULT_MAX_DESCRIPTION_CHARS,
        2,
      );

      const result = await extractor.extract(posting(), () => NOW);

      expect(result).toEqual({
        ok: false,
        reason: "extraction_failed",
        attempts: 3,
        permanent: false,
      });
    });

    it("rejects a requirement whose text exceeds the per-field length bound", async () => {
      const ask = vi.fn(async () =>
        JSON.stringify({
          requirements: [
            {
              text: "x".repeat(MAX_REQUIREMENT_TEXT_CHARS + 1),
              category: "language",
              weight: "mandatory",
            },
          ],
          seniority: null,
          experienceYears: null,
        }),
      );
      const extractor = new StageAExtractor(ask, extractionsRepo);

      const result = await extractor.extract(posting(), () => NOW);

      expect(result).toEqual({
        ok: false,
        reason: "extraction_failed",
        attempts: 3,
        permanent: false,
      });
    });
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
      inputTruncated: false,
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
        "a-v4",
        "unknown",
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
