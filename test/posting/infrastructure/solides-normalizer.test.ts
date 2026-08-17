import { describe, expect, it } from "vitest";
import { normalizeSolidesJob } from "../../../src/posting/infrastructure/solides-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-17T03:00:00Z");

function rawPosting(payload: unknown): RawPosting {
  return { source: "solides", sourceId: "123", payload };
}

describe("normalizeSolidesJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 123,
        title: "Estágio Backend",
        companyName: "Empresa X",
        city: { id: 1, name: "Rio de Janeiro", state_id: 19 },
        jobType: "presencial",
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
    expect(posting?.workMode).toBe("onsite");
    expect(posting?.source).toBe("solides");
    expect(posting?.sourceId).toBe("123");
  });

  it("sets firstSeenAt, lastSeenAt and collectedAt all to now", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.firstSeenAt).toEqual(NOW);
    expect(posting?.lastSeenAt).toEqual(NOW);
    expect(posting?.collectedAt).toEqual(NOW);
  });

  it("maps homeOffice: true to the domain's 'remote', overriding jobType", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        homeOffice: true,
        jobType: "presencial",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("remote");
  });

  it("maps jobType 'presencial' with homeOffice false to 'onsite'", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        homeOffice: false,
        jobType: "presencial",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("onsite");
  });

  it("maps an absent or unrecognized jobType/homeOffice to 'unknown'", () => {
    const withNone = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    const withUnrecognized = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        jobType: "hibrido",
      }),
      NOW,
    );
    expect(withNone?.workMode).toBe("unknown");
    expect(withUnrecognized?.workMode).toBe("unknown");
  });

  it("treats an absent or null city as an unknown location, not a guess", () => {
    const absent = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    const nullCity = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y", city: null }),
      NOW,
    );
    expect(absent?.location).toEqual({ kind: "unknown" });
    expect(nullCity?.location).toEqual({ kind: "unknown" });
  });

  it("returns null rather than throwing when companyName is absent", () => {
    const posting = normalizeSolidesJob(rawPosting({ id: 1, title: "x" }), NOW);
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing when companyName is an empty string", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing when the payload fails the schema entirely", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ nothingUseful: true }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("retains the validated job as the raw payload", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.rawPayload).toMatchObject({ id: 1, title: "x" });
  });

  it("always sets applicationDeadline to null — Sólides states none", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.applicationDeadline).toBeNull();
  });

  it("parses a well-formed createdAt as publishedAt", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        createdAt: "2026-08-15",
      }),
      NOW,
    );
    expect(posting?.publishedAt).toEqual(new Date("2026-08-15"));
  });

  it("is null, not a thrown error, when createdAt is absent", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
  });

  it("is null, not a thrown error, when createdAt is unparseable", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        createdAt: "not a date",
      }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
  });

  it("maps redirectLink to sourceUrl", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        redirectLink: "https://empresa.solides.jobs/vacancies/1",
      }),
      NOW,
    );
    expect(posting?.sourceUrl).toBe("https://empresa.solides.jobs/vacancies/1");
  });

  it("is null, not a thrown error, when redirectLink is absent", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.sourceUrl).toBeNull();
  });

  it("maps the job description", () => {
    const posting = normalizeSolidesJob(
      rawPosting({
        id: 1,
        title: "x",
        companyName: "Y",
        description: "Vaga para estágio em backend com Node.js.",
      }),
      NOW,
    );
    expect(posting?.description).toBe(
      "Vaga para estágio em backend com Node.js.",
    );
  });

  it("is null, not a thrown error, when the description is absent", () => {
    const posting = normalizeSolidesJob(
      rawPosting({ id: 1, title: "x", companyName: "Y" }),
      NOW,
    );
    expect(posting?.description).toBeNull();
  });
});
