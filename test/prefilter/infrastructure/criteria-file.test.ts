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

  it("weighs trackAlignment above mandatoryCoverage (ADR-026)", () => {
    // A guard against silently reverting the 2026-08-16 recalibration —
    // requested directly, after mandatoryCoverage's 65% share left
    // trackAlignment's 15% unable to keep a real, partially-matched dev
    // posting out of `review`. Asserts the relationship the ADR is actually
    // about, not the exact numbers, so a further deliberate recalibration
    // doesn't have to touch this test as long as the relationship holds.
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    const { weights } = loadCriteria(filePath).scoring;
    expect(weights.trackAlignment).toBeGreaterThan(weights.mandatory);
  });
});
