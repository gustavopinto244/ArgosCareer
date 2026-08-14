import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import { deriveProfileKeywords } from "../../../src/profile/domain/profile-keywords";

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
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
    ...overrides,
  };
}

describe("deriveProfileKeywords", () => {
  it("includes every competency name and its aliases", () => {
    const keywords = deriveProfileKeywords(profile());
    expect(keywords).toEqual(["Node.js", "NodeJS"]);
  });

  it("flattens across multiple competencies", () => {
    const keywords = deriveProfileKeywords(
      profile({
        competencies: [
          {
            name: "Node.js",
            tracks: ["dev"],
            aliases: [],
            evidence: ["e"],
          },
          {
            name: "Firewall administration",
            tracks: ["security"],
            aliases: ["UFW"],
            evidence: ["e"],
          },
        ],
      }),
    );
    expect(keywords).toEqual(["Node.js", "Firewall administration", "UFW"]);
  });
});
