import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { applyPreFilter } from "../../../src/prefilter/domain/pre-filter";
import { Criteria } from "../../../src/prefilter/domain/criteria";

const NOW = new Date("2026-08-14T03:00:00Z");

function baseCriteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    titleBlocklist: ["sênior", "pleno", "especialista"],
    titleRequired: ["estágio", "estagiário", "intern", "trainee"],
    location: { cities: ["Rio de Janeiro", "Niterói"], allowRemote: true },
    blockedCompanies: ["Empresa Bloqueada"],
    minKeywordAdherence: 0,
    tracks: {
      dev: ["backend", "node"],
      security: ["segurança"],
      automation: ["automação"],
    },
    trackExclusions: { dev: [], security: [], automation: [] },
    trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
    },
    ...overrides,
  };
}

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

describe("applyPreFilter — title blocklist", () => {
  it("rejects a title containing a blocked term", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio Sênior em Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome).toMatchObject({ passed: false, reason: "title_blocked" });
  });

  it("is case- and accent-insensitive", () => {
    const outcome = applyPreFilter(
      posting({ title: "ESTAGIO SENIOR EM BACKEND" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_blocked");
  });
});

describe("applyPreFilter — title required", () => {
  it("rejects a title with none of the required terms", () => {
    const outcome = applyPreFilter(
      posting({ title: "Analista de Backend Pleno" }),
      baseCriteria({ titleBlocklist: [] }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_missing_required_term");
  });

  it("passes when any one required term is present", () => {
    const outcome = applyPreFilter(
      posting({ title: "Trainee de Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — blocked companies", () => {
  it("rejects a posting from a blocked company", () => {
    const outcome = applyPreFilter(
      posting({ company: "Empresa Bloqueada" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });

  it("matches case- and accent-insensitively", () => {
    const outcome = applyPreFilter(
      posting({ company: "empresa bloqueada" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });
});

describe("applyPreFilter — expired", () => {
  it("rejects a posting whose deadline has passed", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: new Date("2026-01-01T00:00:00Z") }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("expired");
  });

  it("passes a posting whose deadline is in the future", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: new Date("2026-12-01T00:00:00Z") }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not reject a posting with no stated deadline — unknown, not expired", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: null }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — location and workMode", () => {
  it("passes a posting in an allowed city", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "Niterói" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects a posting on-site in a city that is not allowed", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("passes a remote posting regardless of city, when remote is allowed", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "remote",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects a remote posting when remote is not allowed by criteria", () => {
    const outcome = applyPreFilter(
      posting({ workMode: "remote" }),
      baseCriteria({
        location: { cities: ["Rio de Janeiro"], allowRemote: false },
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("does not reject an unknown workMode, even with a disallowed known city — cannot rule out remote", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "unknown",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not reject an unknown location with a non-remote workMode — cannot rule out the target region", () => {
    const outcome = applyPreFilter(
      posting({ location: { kind: "unknown" }, workMode: "onsite" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — minimum keyword adherence", () => {
  it("passes when the floor is 0, regardless of keyword overlap", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Vendas" }),
      baseCriteria({ minKeywordAdherence: 0 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects when fewer profile keywords appear in the title than the floor", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Vendas" }),
      baseCriteria({ minKeywordAdherence: 1 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.reason).toBe("insufficient_keyword_adherence");
  });

  it("passes when enough profile keywords appear in the title", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Node e TypeScript" }),
      baseCriteria({ minKeywordAdherence: 2 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — track classification", () => {
  it("is populated even when the posting is rejected", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio Sênior em Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.tracks).toEqual(["dev"]);
  });

  it("is populated on a passing posting", () => {
    const outcome = applyPreFilter(posting(), baseCriteria(), [], NOW);
    expect(outcome.tracks).toEqual(["dev"]);
  });
});

describe("applyPreFilter — ordering", () => {
  it("reports the first failing rule when a posting fails several at once", () => {
    // Fails title blocklist, title required is moot, company blocked, and
    // location — only the first rule's reason should be reported.
    const outcome = applyPreFilter(
      posting({
        title: "Analista Sênior Pleno",
        company: "Empresa Bloqueada",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_blocked");
  });

  it("checks company before location, when title passes", () => {
    const outcome = applyPreFilter(
      posting({
        company: "Empresa Bloqueada",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });

  it("checks expiry before location, when title and company pass", () => {
    const outcome = applyPreFilter(
      posting({
        applicationDeadline: new Date("2020-01-01T00:00:00Z"),
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("expired");
  });

  it("checks location before keyword adherence", () => {
    const outcome = applyPreFilter(
      posting({
        title: "Estágio em Vendas",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria({ minKeywordAdherence: 5 }),
      ["typescript"],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });
});
