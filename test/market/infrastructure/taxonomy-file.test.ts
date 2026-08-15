import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTaxonomy } from "../../../src/market/infrastructure/taxonomy-loader";

/**
 * config/taxonomy.yaml is committed, real, and consumed by M10's aggregate
 * queries. This is the guard that keeps it structurally valid as the schema
 * evolves.
 */
describe("config/taxonomy.yaml", () => {
  it("loads and validates against TaxonomySchema", () => {
    const filePath = join(process.cwd(), "config", "taxonomy.yaml");
    expect(() => loadTaxonomy(filePath)).not.toThrow();
  });

  it("has no duplicate canonical names", () => {
    const filePath = join(process.cwd(), "config", "taxonomy.yaml");
    const taxonomy = loadTaxonomy(filePath);
    const canonicals = taxonomy.skills.map((skill) => skill.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });
});
