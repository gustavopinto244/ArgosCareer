import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCriteria } from "../../../src/prefilter/infrastructure/criteria-loader";

/**
 * config/criteria.yaml is committed, real, and consumed by the CLI. This is
 * the guard that keeps it structurally valid as the schema evolves.
 */
describe("config/criteria.yaml", () => {
  it("loads and validates against CriteriaSchema", () => {
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    expect(() => loadCriteria(filePath)).not.toThrow();
  });

  it("keeps dev and security as equal first priorities", () => {
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    const criteria = loadCriteria(filePath);
    expect(criteria.trackWeights.dev).toBe(criteria.trackWeights.security);
  });
});
