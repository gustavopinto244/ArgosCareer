import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import {
  isKnownProfileEvidence,
  stripEvidenceTag,
} from "../../../src/scoring/domain/evidence-provenance";

function profile(overrides: Partial<Profile> = {}): Profile {
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
    ...overrides,
  };
}

describe("stripEvidenceTag", () => {
  it("strips the '- [Competency] ' decoration the prompt adds", () => {
    expect(stripEvidenceTag("- [Node.js] Built the API.")).toBe(
      "Built the API.",
    );
  });

  it("leaves an undecorated quote unchanged", () => {
    expect(stripEvidenceTag("Built the API.")).toBe("Built the API.");
  });
});

describe("isKnownProfileEvidence (docs/audit AC-008)", () => {
  it("accepts a quote that verbatim-matches a real profile evidence line", () => {
    const p = profile();
    expect(
      isKnownProfileEvidence("Built atlas-manager's HTTP layer in Node.js.", p),
    ).toBe(true);
  });

  it("accepts the same quote with the prompt's '- [Competency] ' tag still attached", () => {
    const p = profile();
    expect(
      isKnownProfileEvidence(
        "- [Node.js] Built atlas-manager's HTTP layer in Node.js.",
        p,
      ),
    ).toBe(true);
  });

  it("rejects a fabricated quote that does not appear anywhere in the profile", () => {
    // The real-world scenario this guards against: a prompt-injected
    // instruction in the posting text asks the model to invent evidence and
    // report `met`. The model can return syntactically valid JSON, but the
    // text itself is not something isKnownProfileEvidence will ever find.
    const p = profile();
    expect(
      isKnownProfileEvidence(
        "Led a team of 50 engineers at a Fortune 500 company.",
        p,
      ),
    ).toBe(false);
  });

  it("rejects a quote that is close to, but not identical to, a real profile line", () => {
    // Deliberately no fuzzy matching (see the function's own doc comment):
    // "close" is exactly as unverifiable as "invented outright".
    const p = profile();
    expect(
      isKnownProfileEvidence(
        "Built atlas-manager's HTTP and gRPC layers in Node.js.",
        p,
      ),
    ).toBe(false);
  });

  it("rejects evidence when the profile has no competencies at all", () => {
    const p = profile({ competencies: [] });
    expect(isKnownProfileEvidence("Anything at all.", p)).toBe(false);
  });
});
