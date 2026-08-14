import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";

const validInput = {
  source: "gupy",
  sourceId: "abc123",
  company: "Empresa X",
  title: "Estágio Backend",
  location: { kind: "known" as const, city: "Rio de Janeiro" },
  workMode: "remote" as const,
  collectedAt: new Date("2026-08-14T03:00:00Z"),
  firstSeenAt: new Date("2026-08-14T03:00:00Z"),
  lastSeenAt: new Date("2026-08-14T03:00:00Z"),
  rawPayload: { title: "Estágio Backend" },
};

describe("createPosting", () => {
  it("computes the fingerprint from company, title and city", () => {
    const posting = createPosting(validInput);
    expect(posting.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trims company, title, source and sourceId", () => {
    const posting = createPosting({
      ...validInput,
      source: "  gupy  ",
      sourceId: "  abc123  ",
      company: "  Empresa X  ",
      title: "  Estágio Backend  ",
    });
    expect(posting.source).toBe("gupy");
    expect(posting.sourceId).toBe("abc123");
    expect(posting.company).toBe("Empresa X");
    expect(posting.title).toBe("Estágio Backend");
  });

  it("rejects an empty company", () => {
    expect(() => createPosting({ ...validInput, company: "   " })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => createPosting({ ...validInput, title: "" })).toThrow();
  });

  it("rejects an empty source", () => {
    expect(() => createPosting({ ...validInput, source: "" })).toThrow();
  });

  it("rejects an empty sourceId", () => {
    expect(() => createPosting({ ...validInput, sourceId: "   " })).toThrow();
  });

  it("uses an empty city in the fingerprint when location is unknown", () => {
    const known = createPosting(validInput);
    const unknown = createPosting({
      ...validInput,
      location: { kind: "unknown" },
    });
    expect(unknown.fingerprint).not.toBe(known.fingerprint);
  });

  it("defaults seniority and experienceYears to null when omitted", () => {
    const posting = createPosting(validInput);
    expect(posting.seniority).toBeNull();
    expect(posting.experienceYears).toBeNull();
  });

  it("keeps location and workMode as independent fields", () => {
    const posting = createPosting({
      ...validInput,
      location: { kind: "known", city: "São Paulo" },
      workMode: "remote",
    });
    expect(posting.location).toEqual({ kind: "known", city: "São Paulo" });
    expect(posting.workMode).toBe("remote");
  });

  it("retains the raw source payload", () => {
    const payload = { anything: "the source sent" };
    const posting = createPosting({ ...validInput, rawPayload: payload });
    expect(posting.rawPayload).toBe(payload);
  });
});
