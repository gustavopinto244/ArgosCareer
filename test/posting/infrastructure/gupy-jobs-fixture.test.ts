import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GupyJobSchema,
  GupyResponseEnvelopeSchema,
} from "../../../src/posting/infrastructure/gupy-schema";

/**
 * Guards test/fixtures/gupy-jobs.json (curated, committed) against drift as
 * the schema evolves — see the sibling gupy-jobs.md for provenance. Also
 * guards the structural variety the fixture exists to preserve: badges
 * sometimes present, sometimes absent; all three workplaceType values.
 */
function loadFixture(): unknown {
  const path = join(process.cwd(), "test", "fixtures", "gupy-jobs.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("test/fixtures/gupy-jobs.json", () => {
  it("passes the envelope schema", () => {
    expect(GupyResponseEnvelopeSchema.safeParse(loadFixture()).success).toBe(
      true,
    );
  });

  it("every item passes GupyJobSchema", () => {
    const fixture = loadFixture() as { data: unknown[] };
    for (const item of fixture.data) {
      expect(GupyJobSchema.safeParse(item).success).toBe(true);
    }
  });

  it("preserves the badges-present/badges-absent oddity", () => {
    const fixture = loadFixture() as { data: Record<string, unknown>[] };
    const withBadges = fixture.data.filter((item) => "badges" in item);
    const withoutBadges = fixture.data.filter((item) => !("badges" in item));
    expect(withBadges.length).toBeGreaterThan(0);
    expect(withoutBadges.length).toBeGreaterThan(0);
  });

  it("covers all three observed workplaceType values", () => {
    const fixture = loadFixture() as { data: { workplaceType?: string }[] };
    const values = new Set(fixture.data.map((item) => item.workplaceType));
    expect(values).toEqual(new Set(["remote", "hybrid", "on-site"]));
  });
});
