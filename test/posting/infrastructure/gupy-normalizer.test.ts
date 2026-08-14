import { describe, expect, it } from "vitest";
import { normalizeGupyJob } from "../../../src/posting/infrastructure/gupy-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-14T03:00:00Z");

function rawPosting(payload: unknown): RawPosting {
  return { source: "gupy", sourceId: "123", payload };
}

describe("normalizeGupyJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeGupyJob(
      rawPosting({
        id: 123,
        name: "Estágio Backend",
        careerPageName: "Empresa X",
        city: "Rio de Janeiro",
        workplaceType: "hybrid",
      }),
      NOW,
    );

    expect(posting).not.toBeNull();
    expect(posting?.company).toBe("Empresa X");
    expect(posting?.title).toBe("Estágio Backend");
    expect(posting?.location).toEqual({
      kind: "known",
      city: "Rio de Janeiro",
    });
    expect(posting?.workMode).toBe("hybrid");
    expect(posting?.source).toBe("gupy");
    expect(posting?.sourceId).toBe("123");
  });

  it("sets firstSeenAt, lastSeenAt and collectedAt all to now", () => {
    const posting = normalizeGupyJob(
      rawPosting({ id: 1, name: "x", careerPageName: "Y" }),
      NOW,
    );
    expect(posting?.firstSeenAt).toEqual(NOW);
    expect(posting?.lastSeenAt).toEqual(NOW);
    expect(posting?.collectedAt).toEqual(NOW);
  });

  it("maps workplaceType 'on-site' to the domain's 'onsite'", () => {
    const posting = normalizeGupyJob(
      rawPosting({
        id: 1,
        name: "x",
        careerPageName: "Y",
        workplaceType: "on-site",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("onsite");
  });

  it("maps an absent or unrecognized workplaceType to 'unknown'", () => {
    const withNone = normalizeGupyJob(
      rawPosting({ id: 1, name: "x", careerPageName: "Y" }),
      NOW,
    );
    const withUnrecognized = normalizeGupyJob(
      rawPosting({
        id: 1,
        name: "x",
        careerPageName: "Y",
        workplaceType: "flexible",
      }),
      NOW,
    );
    expect(withNone?.workMode).toBe("unknown");
    expect(withUnrecognized?.workMode).toBe("unknown");
  });

  it("treats an absent city as an unknown location, not a guess", () => {
    const posting = normalizeGupyJob(
      rawPosting({ id: 1, name: "x", careerPageName: "Y" }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
  });

  it("returns null rather than throwing when careerPageName is absent", () => {
    const posting = normalizeGupyJob(rawPosting({ id: 1, name: "x" }), NOW);
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing when careerPageName is an empty string", () => {
    const posting = normalizeGupyJob(
      rawPosting({ id: 1, name: "x", careerPageName: "" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing when the payload fails the schema entirely", () => {
    const posting = normalizeGupyJob(rawPosting({ nothingUseful: true }), NOW);
    expect(posting).toBeNull();
  });

  it("retains the validated job as the raw payload", () => {
    const posting = normalizeGupyJob(
      rawPosting({ id: 1, name: "x", careerPageName: "Y" }),
      NOW,
    );
    expect(posting?.rawPayload).toMatchObject({ id: 1, name: "x" });
  });
});
