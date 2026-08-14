import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../../../src/profile/infrastructure/profile-loader";

/**
 * config/profile.example.yaml is the setup documentation for anyone cloning
 * the repository (docs/adr/004). This is the guard that keeps it structurally
 * valid as the schema evolves, instead of silently going stale.
 */
describe("config/profile.example.yaml", () => {
  it("loads and validates against ProfileSchema", () => {
    const filePath = join(process.cwd(), "config", "profile.example.yaml");
    expect(() => loadProfile(filePath)).not.toThrow();
  });

  it("declares at least one variant per resume the project actually has", () => {
    const filePath = join(process.cwd(), "config", "profile.example.yaml");
    const profile = loadProfile(filePath);
    const ids = profile.resumeVariants.map((variant) => variant.id);
    expect(ids).toEqual(expect.arrayContaining(["backend", "infra-security"]));
  });
});
