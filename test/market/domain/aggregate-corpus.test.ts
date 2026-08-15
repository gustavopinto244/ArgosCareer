import { describe, expect, it } from "vitest";
import { aggregateCorpus } from "../../../src/market/domain/aggregate-corpus";
import { Taxonomy } from "../../../src/market/domain/taxonomy";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Requirement } from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");

const TAXONOMY: Taxonomy = {
  skills: [
    { canonical: "PostgreSQL", aliases: ["Postgres"] },
    { canonical: "Docker", aliases: [] },
  ],
};

function requirement(text: string): Requirement {
  return { text, category: "", weight: "mandatory" };
}

function entry(
  overrides: Partial<{
    company: string;
    city: string | null;
    workMode: "remote" | "hybrid" | "onsite" | "unknown";
    seniority: "internship" | "trainee" | "junior" | "mid" | "senior" | null;
    requirements: Requirement[];
  }> = {},
): CorpusEntry {
  const posting = createPosting({
    source: "gupy",
    sourceId: `id-${Math.random()}`,
    company: overrides.company ?? "Acme",
    title: "Estágio em Desenvolvimento",
    location:
      overrides.city === undefined
        ? { kind: "unknown" }
        : overrides.city === null
          ? { kind: "unknown" }
          : { kind: "known", city: overrides.city },
    workMode: overrides.workMode ?? "remote",
    seniority: overrides.seniority ?? null,
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
  return {
    posting,
    requirements: overrides.requirements ?? [],
    matches: null,
    verdict: null,
  };
}

describe("aggregateCorpus", () => {
  it("counts the whole corpus, extraction coverage separately", () => {
    const entries = [
      entry({ requirements: [requirement("PostgreSQL required")] }),
      entry({ requirements: [] }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.corpusSize).toBe(2);
    expect(result.extractedCount).toBe(1);
  });

  it("deduplicates a skill mentioned in multiple requirements of one posting", () => {
    const entries = [
      entry({
        requirements: [
          requirement("PostgreSQL experience"),
          requirement("Also PostgreSQL for reporting"),
        ],
      }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.skillFrequency).toEqual([
      { skill: "PostgreSQL", count: 1, percentage: 1 },
    ]);
  });

  it("computes skill percentage over extracted postings, not the whole corpus", () => {
    const entries = [
      entry({ requirements: [requirement("Docker required")] }),
      entry({ requirements: [] }),
      entry({ requirements: [] }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.skillFrequency).toEqual([
      { skill: "Docker", count: 1, percentage: 1 },
    ]);
  });

  it("counts companies, regions, work modes and experience levels over the whole corpus", () => {
    const entries = [
      entry({ company: "Acme", city: "Rio de Janeiro", workMode: "remote" }),
      entry({ company: "Acme", city: "Rio de Janeiro", workMode: "hybrid" }),
      entry({
        company: "Globex",
        city: null,
        workMode: "onsite",
        seniority: "internship",
      }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);

    expect(result.companies).toContainEqual({ label: "Acme", count: 2 });
    expect(result.companies).toContainEqual({ label: "Globex", count: 1 });
    expect(result.regions).toContainEqual({
      label: "Rio de Janeiro",
      count: 2,
    });
    expect(result.regions).toContainEqual({ label: "unknown", count: 1 });
    expect(result.workModes.map((w) => w.label).sort()).toEqual(
      ["hybrid", "onsite", "remote"].sort(),
    );
    expect(result.experienceLevels).toContainEqual({
      label: "internship",
      count: 1,
    });
    expect(result.experienceLevels).toContainEqual({
      label: "unknown",
      count: 2,
    });
  });

  it("returns zero percentages, not NaN, for an empty corpus", () => {
    const result = aggregateCorpus([], TAXONOMY);
    expect(result.corpusSize).toBe(0);
    expect(result.extractedCount).toBe(0);
    expect(result.skillFrequency).toEqual([]);
  });
});
