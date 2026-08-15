import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import { hashProfile } from "../../../src/profile/domain/profile-hash";

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
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
    ...overrides,
  };
}

describe("hashProfile", () => {
  it("is deterministic for the same profile", () => {
    expect(hashProfile(profile())).toBe(hashProfile(profile()));
  });

  it("changes when a competency's evidence changes", () => {
    const a = hashProfile(profile());
    const b = hashProfile(
      profile({
        competencies: [
          {
            name: "Node.js",
            tracks: ["dev"],
            aliases: [],
            evidence: ["Different evidence."],
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });
});
