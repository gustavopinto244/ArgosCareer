import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import {
  createMatch,
  Match,
  Requirement,
} from "../../../src/scoring/domain/types";
import {
  computeRecommendation,
  EMPTY_RECOMMENDATION,
} from "../../../src/scoring/domain/recommendation";

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    text: "Node.js experience",
    category: "language",
    weight: "mandatory",
    ...overrides,
  };
}

function profile(overrides: Partial<Profile> = {}): Profile {
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
        aliases: ["NodeJS"],
        evidence: ["Built atlas-manager's HTTP layer in Node.js."],
      },
      {
        name: "Firewall administration",
        tracks: ["security"],
        aliases: ["UFW"],
        evidence: ["Configured UFW on the Atlas homelab."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
      {
        id: "infra-security",
        tracks: ["security"],
        competencyNames: ["Firewall administration"],
      },
    ],
    ...overrides,
  };
}

describe("computeRecommendation — recommendedVariant", () => {
  it("returns null when there are no matches with evidence", () => {
    const result = computeRecommendation([], profile());
    expect(result.recommendedVariant).toBeNull();
  });

  it("returns null when no match's evidence traces to a real competency", () => {
    const matches: Match[] = [
      createMatch(requirement(), "met", "Unrelated text not in the profile."),
    ];
    expect(
      computeRecommendation(matches, profile()).recommendedVariant,
    ).toBeNull();
  });

  it("picks the variant whose competency the matched evidence traces to", () => {
    const matches: Match[] = [
      createMatch(
        requirement(),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).recommendedVariant).toBe(
      "backend",
    );
  });

  it("picks the variant with more overlapping competencies when several match", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ text: "Node.js" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
      createMatch(
        requirement({ text: "Firewalls" }),
        "met",
        "Configured UFW on the Atlas homelab.",
      ),
    ];
    const twoCompetencyVariant = profile({
      resumeVariants: [
        { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
        {
          id: "full-stack-security",
          tracks: ["dev", "security"],
          competencyNames: ["Node.js", "Firewall administration"],
        },
      ],
    });
    expect(
      computeRecommendation(matches, twoCompetencyVariant).recommendedVariant,
    ).toBe("full-stack-security");
  });

  it("counts partial matches toward the recommendation, not only met", () => {
    const matches: Match[] = [
      createMatch(
        requirement(),
        "partial",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).recommendedVariant).toBe(
      "backend",
    );
  });
});

describe("computeRecommendation — highlights", () => {
  it("includes evidence from a met mandatory match", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ weight: "mandatory" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).highlights).toEqual([
      "Built atlas-manager's HTTP layer in Node.js.",
    ]);
  });

  it("includes evidence from a met blocking match", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ weight: "blocking" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).highlights).toHaveLength(
      1,
    );
  });

  it("excludes a met desirable match", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ weight: "desirable" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).highlights).toEqual([]);
  });

  it("excludes a partial match, even on a mandatory requirement", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ weight: "mandatory" }),
        "partial",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).highlights).toEqual([]);
  });

  it("deduplicates identical evidence supporting more than one requirement", () => {
    const evidence = "Built atlas-manager's HTTP layer in Node.js.";
    const matches: Match[] = [
      createMatch(requirement({ text: "Node.js" }), "met", evidence),
      createMatch(requirement({ text: "Backend APIs" }), "met", evidence),
    ];
    expect(computeRecommendation(matches, profile()).highlights).toEqual([
      evidence,
    ]);
  });
});

describe("computeRecommendation — missingTerms", () => {
  it("flags a met requirement whose wording matches no profile keyword", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ text: "CI/CD pipelines" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).missingTerms).toEqual([
      "CI/CD pipelines",
    ]);
  });

  it("does not flag a met requirement whose wording already names a profile competency", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ text: "Node.js experience required" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).missingTerms).toEqual([]);
  });

  it("does not flag a competency reached through an alias", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ text: "Experience with NodeJS" }),
        "met",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).missingTerms).toEqual([]);
  });

  it("ignores a not_met requirement even when its wording matches nothing", () => {
    const matches: Match[] = [
      createMatch(requirement({ text: "Kubernetes" }), "not_met", null),
    ];
    expect(computeRecommendation(matches, profile()).missingTerms).toEqual([]);
  });

  it("flags a partial match the same as a met one", () => {
    const matches: Match[] = [
      createMatch(
        requirement({ text: "GraphQL APIs" }),
        "partial",
        "Built atlas-manager's HTTP layer in Node.js.",
      ),
    ];
    expect(computeRecommendation(matches, profile()).missingTerms).toEqual([
      "GraphQL APIs",
    ]);
  });
});

describe("EMPTY_RECOMMENDATION", () => {
  it("matches what computeRecommendation returns for an empty match list", () => {
    expect(computeRecommendation([], profile())).toEqual(EMPTY_RECOMMENDATION);
  });
});
