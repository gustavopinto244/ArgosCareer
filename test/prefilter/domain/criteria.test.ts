import { describe, expect, it } from "vitest";
import { CriteriaSchema } from "../../../src/prefilter/domain/criteria";

function validCriteria() {
  return {
    titleBlocklist: ["sênior", "pleno"],
    titleRequired: ["estágio", "estagiário"],
    location: { cities: ["Rio de Janeiro"], allowRemote: true },
    blockedCompanies: [],
    minKeywordAdherence: 1,
    tracks: {
      dev: ["backend", "node"],
      security: ["segurança", "firewall"],
      automation: ["automação", "devops"],
    },
    trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
    },
  };
}

describe("CriteriaSchema", () => {
  it("accepts a structurally valid criteria document", () => {
    expect(CriteriaSchema.safeParse(validCriteria()).success).toBe(true);
  });

  it("requires titleRequired to have at least one entry", () => {
    const criteria = { ...validCriteria(), titleRequired: [] };
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("defaults titleBlocklist and blockedCompanies to empty arrays when omitted", () => {
    const {
      titleBlocklist: _tb,
      blockedCompanies: _bc,
      ...rest
    } = validCriteria();
    const result = CriteriaSchema.parse(rest);
    expect(result.titleBlocklist).toEqual([]);
    expect(result.blockedCompanies).toEqual([]);
  });

  it("defaults minKeywordAdherence to 0 when omitted", () => {
    const { minKeywordAdherence: _mka, ...rest } = validCriteria();
    expect(CriteriaSchema.parse(rest).minKeywordAdherence).toBe(0);
  });

  it("rejects a tracks table missing one of the three required tracks", () => {
    const criteria = validCriteria();
    // @ts-expect-error deliberately incomplete for the test
    delete criteria.tracks.automation;
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("rejects an unknown track key in the tracks table", () => {
    const criteria = {
      ...validCriteria(),
      tracks: { ...validCriteria().tracks, madeUpTrack: ["x"] },
    };
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("requires every trackWeights field", () => {
    const criteria = validCriteria();
    // @ts-expect-error deliberately incomplete for the test
    delete criteria.trackWeights.unknown;
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("requires the scoring section", () => {
    const { scoring: _scoring, ...rest } = validCriteria();
    expect(CriteriaSchema.safeParse(rest).success).toBe(false);
  });

  it("parses scoring's weights and thresholds correctly", () => {
    const result = CriteriaSchema.parse(validCriteria());
    expect(result.scoring.weights).toEqual({
      mandatory: 65,
      desirable: 20,
      trackAlignment: 15,
    });
    expect(result.scoring.thresholds).toEqual({ apply: 70, review: 45 });
  });

  it("location defaults allowRemote to true and cities to empty when omitted", () => {
    const result = CriteriaSchema.parse({ ...validCriteria(), location: {} });
    expect(result.location).toEqual({ cities: [], allowRemote: true });
  });
});
