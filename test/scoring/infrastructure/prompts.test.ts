import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import { Requirement } from "../../../src/scoring/domain/types";
import {
  buildStageAPrompt,
  buildStageBPrompt,
  STAGE_A_PROMPT_PATH,
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_PATH,
  STAGE_B_PROMPT_VERSION,
} from "../../../src/scoring/infrastructure/prompts";

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
        aliases: [],
        evidence: [
          "Built atlas-manager's HTTP layer in Node.js/TypeScript.",
          "Wrote a Vitest + Supertest suite covering the same layer.",
        ],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
    ...overrides,
  };
}

describe("prompt version constants", () => {
  it("point at files that actually exist on disk", () => {
    expect(existsSync(STAGE_A_PROMPT_PATH)).toBe(true);
    expect(existsSync(STAGE_B_PROMPT_PATH)).toBe(true);
  });

  it("are pinned to v1", () => {
    expect(STAGE_A_PROMPT_VERSION).toBe("a-v1");
    expect(STAGE_B_PROMPT_VERSION).toBe("b-v1");
  });
});

describe("buildStageAPrompt", () => {
  it("substitutes the posting title and description into the template", () => {
    const prompt = buildStageAPrompt(
      "Estágio em Desenvolvimento Backend",
      "Buscamos estagiário com conhecimento em Node.js.",
    );

    expect(prompt).toContain("Estágio em Desenvolvimento Backend");
    expect(prompt).toContain(
      "Buscamos estagiário com conhecimento em Node.js.",
    );
    expect(prompt).not.toContain("{{POSTING_TITLE}}");
    expect(prompt).not.toContain("{{POSTING_DESCRIPTION}}");
  });

  it("substitutes a placeholder note when the description is null", () => {
    const prompt = buildStageAPrompt("Estágio em Backend", null);
    expect(prompt).toContain("(not provided)");
  });

  it("throws a clear error when the prompt file does not exist", () => {
    expect(() =>
      buildStageAPrompt("x", null, "./prompts/does-not-exist.md"),
    ).toThrow();
  });
});

describe("buildStageBPrompt", () => {
  const requirement: Requirement = {
    text: "Experiência com Node.js",
    category: "language",
    weight: "mandatory",
  };

  it("substitutes the requirement's fields into the template", () => {
    const prompt = buildStageBPrompt(requirement, profile());

    expect(prompt).toContain("Experiência com Node.js");
    expect(prompt).toContain("language");
    expect(prompt).toContain("mandatory");
    expect(prompt).not.toContain("{{REQUIREMENT_TEXT}}");
  });

  it("includes every competency's evidence, tagged by competency name", () => {
    const prompt = buildStageBPrompt(requirement, profile());

    expect(prompt).toContain(
      "[Node.js] Built atlas-manager's HTTP layer in Node.js/TypeScript.",
    );
    expect(prompt).toContain(
      "[Node.js] Wrote a Vitest + Supertest suite covering the same layer.",
    );
  });

  it("includes evidence from every competency, not only the first", () => {
    const twoCompetencies = profile({
      competencies: [
        {
          name: "Node.js",
          tracks: ["dev"],
          aliases: [],
          evidence: ["Built a Node.js service."],
        },
        {
          name: "Firewall administration",
          tracks: ["security"],
          aliases: [],
          evidence: ["Configured UFW on the Atlas homelab."],
        },
      ],
    });
    const prompt = buildStageBPrompt(requirement, twoCompetencies);

    expect(prompt).toContain("[Node.js] Built a Node.js service.");
    expect(prompt).toContain(
      "[Firewall administration] Configured UFW on the Atlas homelab.",
    );
  });
});
