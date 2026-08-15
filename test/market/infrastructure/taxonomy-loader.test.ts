import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTaxonomy,
  TaxonomyValidationError,
} from "../../../src/market/infrastructure/taxonomy-loader";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-taxonomy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_YAML = `
skills:
  - canonical: PostgreSQL
    aliases: [Postgres, Postgre]
  - canonical: Docker
    aliases: []
`;

function writeTaxonomy(contents: string): string {
  const filePath = join(dir, "taxonomy.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

describe("loadTaxonomy", () => {
  it("loads and validates a well-formed taxonomy file", () => {
    const taxonomy = loadTaxonomy(writeTaxonomy(VALID_YAML));
    expect(taxonomy.skills).toHaveLength(2);
    expect(taxonomy.skills[0]?.canonical).toBe("PostgreSQL");
  });

  it("defaults aliases to an empty array when omitted", () => {
    const taxonomy = loadTaxonomy(
      writeTaxonomy("skills:\n  - canonical: Docker\n"),
    );
    expect(taxonomy.skills[0]?.aliases).toEqual([]);
  });

  it("throws naming the file path when the file does not exist", () => {
    const missing = join(dir, "does-not-exist.yaml");
    expect(() => loadTaxonomy(missing)).toThrowError(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws TaxonomyValidationError naming the exact field on schema failure", () => {
    const filePath = writeTaxonomy("skills: []\n");

    let caught: unknown;
    try {
      loadTaxonomy(filePath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaxonomyValidationError);
    expect((caught as Error).message).toContain(filePath);
    expect((caught as Error).message).toContain("skills");
  });
});
