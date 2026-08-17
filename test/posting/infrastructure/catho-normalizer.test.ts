import { describe, expect, it } from "vitest";
import { normalizeCathoJob } from "../../../src/posting/infrastructure/catho-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-17T03:00:00Z");

function rawPosting(payload: unknown): RawPosting {
  return { source: "catho", sourceId: "37070531", payload };
}

const REAL_PAYLOAD = {
  id: 37070531,
  url: "https://www.catho.com.br/vagas/estagio-tecnico-mecanica/37070531/",
  pageTitle: "Vaga de Emprego de Estágio Técnico Mecânica, Paulinia /",
  jobPosting: {
    title: "Estágio Técnico Mecânica",
    description: "Descrição da vaga",
    datePosted: "2026-06-15T23:59:59Z",
    hiringOrganization: { name: "MILLS" },
    jobLocation: [
      {
        address: {
          addressLocality: "São Paulo",
          addressRegion: "SP",
          postalCode: "13148-150",
        },
      },
    ],
  },
};

describe("normalizeCathoJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);

    expect(posting).not.toBeNull();
    expect(posting?.company).toBe("MILLS");
    expect(posting?.title).toBe("Estágio Técnico Mecânica");
    expect(posting?.source).toBe("catho");
    expect(posting?.sourceId).toBe("37070531");
  });

  it("parses the city from the page title, not from jobLocation.addressLocality", () => {
    // The real bug this test guards against: addressLocality said "São Paulo"
    // on this exact real sample, for a posting actually in Paulínia.
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.location).toEqual({ kind: "known", city: "Paulinia" });
  });

  it("parses a second real page-title shape correctly", () => {
    const posting = normalizeCathoJob(
      rawPosting({
        ...REAL_PAYLOAD,
        pageTitle: "Vaga de Emprego de Estágio de Direito, Santos /",
        jobPosting: { ...REAL_PAYLOAD.jobPosting, title: "Estágio de Direito" },
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "known", city: "Santos" });
  });

  it("treats an absent or unparseable pageTitle as unknown location", () => {
    const absent = normalizeCathoJob(
      rawPosting({
        id: 1,
        jobPosting: { title: "x", hiringOrganization: { name: "Y" } },
      }),
      NOW,
    );
    const unparseable = normalizeCathoJob(
      rawPosting({
        id: 1,
        pageTitle: "Something entirely different",
        jobPosting: { title: "x", hiringOrganization: { name: "Y" } },
      }),
      NOW,
    );
    expect(absent?.location).toEqual({ kind: "unknown" });
    expect(unparseable?.location).toEqual({ kind: "unknown" });
  });

  it("maps jobLocationType TELECOMMUTE to remote, never observed but tolerated", () => {
    const posting = normalizeCathoJob(
      rawPosting({
        id: 1,
        jobPosting: {
          title: "x",
          hiringOrganization: { name: "Y" },
          jobLocationType: "TELECOMMUTE",
        },
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("remote");
  });

  it("maps an absent jobLocationType to unknown, not onsite", () => {
    const posting = normalizeCathoJob(
      rawPosting({
        id: 1,
        jobPosting: { title: "x", hiringOrganization: { name: "Y" } },
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("unknown");
  });

  it("sets firstSeenAt, lastSeenAt and collectedAt all to now", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.firstSeenAt).toEqual(NOW);
    expect(posting?.lastSeenAt).toEqual(NOW);
    expect(posting?.collectedAt).toEqual(NOW);
  });

  it("returns null rather than throwing when hiringOrganization.name is absent", () => {
    const posting = normalizeCathoJob(
      rawPosting({ id: 1, jobPosting: { title: "x" } }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing when the payload fails the schema entirely", () => {
    const posting = normalizeCathoJob(rawPosting({ nothingUseful: true }), NOW);
    expect(posting).toBeNull();
  });

  it("retains the validated envelope as the raw payload", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.rawPayload).toMatchObject({ id: 37070531 });
  });

  it("parses datePosted as publishedAt", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.publishedAt).toEqual(new Date("2026-06-15T23:59:59Z"));
  });

  it("is null, not a thrown error, when datePosted is absent", () => {
    const posting = normalizeCathoJob(
      rawPosting({
        id: 1,
        jobPosting: { title: "x", hiringOrganization: { name: "Y" } },
      }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
  });

  it("maps the url field to sourceUrl", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.sourceUrl).toBe(REAL_PAYLOAD.url);
  });

  it("maps the job description", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.description).toBe("Descrição da vaga");
  });

  it("always sets applicationDeadline to null — Catho states none", () => {
    const posting = normalizeCathoJob(rawPosting(REAL_PAYLOAD), NOW);
    expect(posting?.applicationDeadline).toBeNull();
  });
});
