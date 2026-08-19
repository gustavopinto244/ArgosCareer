import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProfile,
  ProfileValidationError,
} from "../../../src/profile/infrastructure/profile-loader";

// Real temporary files, not a mocked fs — a filesystem mocked against itself
// tests nothing (docs/07-testing-strategy.md).
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-profile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_YAML = `
courseName: Sistemas de Informação
institution: Universidade Exemplo
courseStart: 2026-03-01
courseEnd: 2029-12-01
englishLevel: "⚠ VERIFY"
minimumStipend: "⚠ VERIFY"
maxWeeklyHours: "⚠ VERIFY"
workAvailability: "⚠ VERIFY"
competencies:
  - name: Node.js
    tracks: [dev]
    aliases: [NodeJS]
    evidence:
      - "Built atlas-manager's HTTP layer in Node.js/TypeScript."
resumeVariants:
  - id: backend
    tracks: [dev]
    competencyNames: [Node.js]
`;

function writeProfile(contents: string): string {
  const filePath = join(dir, "profile.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

describe("loadProfile", () => {
  it("loads and validates a well-formed profile file", () => {
    const filePath = writeProfile(VALID_YAML);
    const profile = loadProfile(filePath);
    expect(profile.competencies).toHaveLength(1);
    expect(profile.courseStart).toBeInstanceOf(Date);
  });

  it("throws naming the file path when the file does not exist", () => {
    const missing = join(dir, "does-not-exist.yaml");
    expect(() => loadProfile(missing)).toThrowError(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws naming the file path on malformed YAML", () => {
    const filePath = writeProfile("competencies: [this is: not: valid");
    expect(() => loadProfile(filePath)).toThrowError(
      new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws ProfileValidationError naming the exact field on schema failure", () => {
    const filePath = writeProfile(
      VALID_YAML.replace(
        'evidence:\n      - "Built atlas-manager\'s HTTP layer in Node.js/TypeScript."',
        "evidence: []",
      ),
    );

    let caught: unknown;
    try {
      loadProfile(filePath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProfileValidationError);
    expect((caught as Error).message).toContain(filePath);
    expect((caught as Error).message).toContain("competencies.0.evidence");
  });
});
