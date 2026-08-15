import { describe, expect, it } from "vitest";
import {
  Competency,
  ProfileSchema,
  ResumeVariant,
  UNVERIFIED,
} from "../../../src/profile/domain/profile";

const nodeCompetency: Competency = {
  name: "Node.js",
  tracks: ["dev"],
  aliases: ["NodeJS"],
  evidence: ["Built atlas-manager's HTTP layer in Node.js/TypeScript."],
};

const firewallCompetency: Competency = {
  name: "Firewall administration",
  tracks: ["security", "automation"],
  aliases: ["UFW"],
  evidence: ["Configured UFW and Fail2ban on the Atlas homelab."],
};

const backendVariant: ResumeVariant = {
  id: "backend",
  tracks: ["dev"],
  competencyNames: ["Node.js"],
};

const infraSecurityVariant: ResumeVariant = {
  id: "infra-security",
  tracks: ["security", "automation"],
  competencyNames: ["Firewall administration"],
};

function validProfile() {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: "2026-03-01",
    courseEnd: "2029-12-01",
    englishLevel: UNVERIFIED,
    minimumStipend: UNVERIFIED,
    maxWeeklyHours: UNVERIFIED,
    competencies: [nodeCompetency, firewallCompetency],
    resumeVariants: [backendVariant, infraSecurityVariant],
  };
}

function issuePaths(result: ReturnType<typeof ProfileSchema.safeParse>) {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("ProfileSchema", () => {
  it("accepts a structurally valid profile", () => {
    const result = ProfileSchema.safeParse(validProfile());
    expect(result.success).toBe(true);
  });

  it("coerces courseStart and courseEnd to Date", () => {
    const result = ProfileSchema.parse(validProfile());
    expect(result.courseStart).toBeInstanceOf(Date);
    expect(result.courseEnd).toBeInstanceOf(Date);
  });

  it("rejects a competency with no evidence", () => {
    const profile = {
      ...validProfile(),
      competencies: [{ ...nodeCompetency, evidence: [] }],
      resumeVariants: [backendVariant],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("competencies.0.evidence");
  });

  it("rejects a competency with no tracks", () => {
    const profile = {
      ...validProfile(),
      competencies: [{ ...nodeCompetency, tracks: [] }],
      resumeVariants: [backendVariant],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown track value", () => {
    const profile = {
      ...validProfile(),
      competencies: [{ ...nodeCompetency, tracks: ["unknown"] }],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("defaults aliases to an empty array when omitted", () => {
    const { aliases: _aliases, ...withoutAliases } = nodeCompetency;
    const profile = {
      ...validProfile(),
      competencies: [withoutAliases],
      resumeVariants: [backendVariant],
    };
    const result = ProfileSchema.parse(profile);
    expect(result.competencies[0]?.aliases).toEqual([]);
  });

  it("rejects a profile with zero competencies", () => {
    const profile = { ...validProfile(), competencies: [] };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("rejects a profile with zero resume variants", () => {
    const profile = { ...validProfile(), resumeVariants: [] };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate competency names, naming the exact field", () => {
    const profile = {
      ...validProfile(),
      competencies: [nodeCompetency, firewallCompetency, nodeCompetency],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("competencies.2.name");
  });

  it("rejects duplicate resume variant ids, naming the exact field", () => {
    const profile = {
      ...validProfile(),
      resumeVariants: [backendVariant, infraSecurityVariant, backendVariant],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("resumeVariants.2.id");
  });

  it("rejects a resume variant referencing a competency that does not exist", () => {
    const profile = {
      ...validProfile(),
      resumeVariants: [
        { ...backendVariant, competencyNames: ["Nonexistent skill"] },
      ],
    };
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("resumeVariants.0.competencyNames.0");
  });

  it("holds no prose on a resume variant — only an id, tracks and competency references", () => {
    expect(Object.keys(backendVariant).sort()).toEqual(
      ["competencyNames", "id", "tracks"].sort(),
    );
  });
});
