import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SolidesJobSchema,
  SolidesResponseEnvelopeSchema,
} from "../../../src/posting/infrastructure/solides-schema";

/**
 * Guards test/fixtures/solides-jobs.json (curated, committed) against drift
 * as the schema evolves — see the sibling solides-jobs.md for provenance and
 * for what this fixture deliberately does NOT represent (homeOffice: true,
 * any jobType besides "presencial" — never observed during discovery).
 */
function loadFixture(): unknown {
  const path = join(process.cwd(), "test", "fixtures", "solides-jobs.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("test/fixtures/solides-jobs.json", () => {
  it("passes the envelope schema", () => {
    expect(SolidesResponseEnvelopeSchema.safeParse(loadFixture()).success).toBe(
      true,
    );
  });

  it("every item passes SolidesJobSchema", () => {
    const fixture = loadFixture() as { data: { data: unknown[] } };
    for (const item of fixture.data.data) {
      expect(SolidesJobSchema.safeParse(item).success).toBe(true);
    }
  });

  it("preserves the description-length variety (short and long)", () => {
    const fixture = loadFixture() as {
      data: { data: { description?: string }[] };
    };
    const lengths = fixture.data.data.map(
      (item) => item.description?.length ?? 0,
    );
    expect(Math.min(...lengths)).toBeLessThan(200);
    expect(Math.max(...lengths)).toBeGreaterThan(2000);
  });

  it("every curated item has companyName, city and description present", () => {
    const fixture = loadFixture() as {
      data: { data: Record<string, unknown>[] };
    };
    for (const item of fixture.data.data) {
      expect(item.companyName).toBeTruthy();
      expect(item.city).toBeTruthy();
      expect(item.description).toBeTruthy();
    }
  });
});
