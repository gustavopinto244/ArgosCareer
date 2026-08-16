import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeIndeedJob } from "../../../src/posting/infrastructure/indeed-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-16T13:00:00Z");

function rawPosting(payload: unknown, sourceId = "in-1"): RawPosting {
  return { source: "indeed", sourceId, payload };
}

function fixture(): unknown[] {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "test", "fixtures", "indeed-jobs.json"),
      "utf8",
    ),
  ) as unknown[];
}

describe("normalizeIndeedJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeIndeedJob(
      rawPosting({
        id: "in-1",
        title: "Estágio Backend",
        company: "Empresa X",
        location: "Rio de Janeiro, RJ, BR",
        is_remote: false,
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
    expect(posting?.source).toBe("indeed");
    expect(posting?.sourceId).toBe("in-1");
  });

  it("sets firstSeenAt, lastSeenAt and collectedAt all to now", () => {
    const posting = normalizeIndeedJob(
      rawPosting({ id: "in-1", title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.firstSeenAt).toEqual(NOW);
    expect(posting?.lastSeenAt).toEqual(NOW);
    expect(posting?.collectedAt).toEqual(NOW);
  });

  describe("location — one free-text string, unlike Gupy's structured city", () => {
    it("takes the first comma-separated segment as the city", () => {
      const posting = normalizeIndeedJob(
        rawPosting({
          id: "in-1",
          title: "x",
          company: "Y",
          location: "Macaé, RJ, BR",
        }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "known", city: "Macaé" });
    });

    it("is unknown when location is absent", () => {
      const posting = normalizeIndeedJob(
        rawPosting({ id: "in-1", title: "x", company: "Y", location: null }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "unknown" });
    });
  });

  describe("workMode — is_remote is the only signal jobspy gives", () => {
    it("maps is_remote: true to 'remote'", () => {
      const posting = normalizeIndeedJob(
        rawPosting({
          id: "in-1",
          title: "x",
          company: "Y",
          is_remote: true,
        }),
        NOW,
      );
      expect(posting?.workMode).toBe("remote");
    });

    it("maps is_remote: false to 'unknown', not 'onsite' — jobspy cannot tell onsite from hybrid", () => {
      const posting = normalizeIndeedJob(
        rawPosting({
          id: "in-1",
          title: "x",
          company: "Y",
          is_remote: false,
        }),
        NOW,
      );
      expect(posting?.workMode).toBe("unknown");
    });

    it("maps an absent is_remote to 'unknown'", () => {
      const posting = normalizeIndeedJob(
        rawPosting({ id: "in-1", title: "x", company: "Y" }),
        NOW,
      );
      expect(posting?.workMode).toBe("unknown");
    });
  });

  describe("publishedAt — real and present, unlike CIEE (docs/11 B1)", () => {
    it("parses date_posted", () => {
      const posting = normalizeIndeedJob(
        rawPosting({
          id: "in-1",
          title: "x",
          company: "Y",
          date_posted: "2026-08-15T00:00:00.000",
        }),
        NOW,
      );
      expect(posting?.publishedAt).toEqual(new Date("2026-08-15T00:00:00.000"));
    });

    it("is null, not a thrown error, on an unparseable date_posted", () => {
      const posting = normalizeIndeedJob(
        rawPosting({
          id: "in-1",
          title: "x",
          company: "Y",
          date_posted: "not a date",
        }),
        NOW,
      );
      expect(posting?.publishedAt).toBeNull();
    });
  });

  it("maps job_url to sourceUrl", () => {
    const posting = normalizeIndeedJob(
      rawPosting({
        id: "in-1",
        title: "x",
        company: "Y",
        job_url: "https://br.indeed.com/viewjob?jk=1",
      }),
      NOW,
    );
    expect(posting?.sourceUrl).toBe("https://br.indeed.com/viewjob?jk=1");
  });

  it("applicationDeadline is always null — jobspy states no deadline field", () => {
    const posting = normalizeIndeedJob(
      rawPosting({ id: "in-1", title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.applicationDeadline).toBeNull();
  });

  it("is null, not a thrown error, when company is absent", () => {
    const posting = normalizeIndeedJob(
      rawPosting({ id: "in-1", title: "x" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("is null when the payload fails schema validation entirely (no id)", () => {
    const posting = normalizeIndeedJob(
      rawPosting({ title: "x", company: "Y" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  describe("against the curated real-shaped fixture", () => {
    it("normalizes every item in indeed-jobs.json into a valid Posting", () => {
      const items = fixture();
      for (const item of items) {
        const posting = normalizeIndeedJob(rawPosting(item), NOW);
        expect(posting).not.toBeNull();
      }
    });

    it("normalizes the 'parttime' job_type item — job_type is not read, title-based pre-filter handles this", () => {
      // Real oddity (indeed-jobs.md): 3 of 8 real Baker Hughes internships
      // reported job_type "parttime", not "internship". The normalizer must
      // not reject on job_type — it isn't part of the domain Posting at
      // all, and title-based pre-filter rules are what actually decide
      // relevance, the same as every other source.
      const items = fixture();
      const parttimeInternship = items.find(
        (i) => (i as { job_type?: string }).job_type === "parttime",
      );
      expect(parttimeInternship).toBeDefined();
      const posting = normalizeIndeedJob(rawPosting(parttimeInternship), NOW);
      expect(posting).not.toBeNull();
      expect(posting?.title).toContain("Estágio");
    });
  });
});
