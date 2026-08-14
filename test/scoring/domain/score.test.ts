import { describe, expect, it } from "vitest";
import {
  computeScore,
  computeTrackAlignment,
} from "../../../src/scoring/domain/score";
import {
  createMatch,
  Requirement,
  ScoringConfig,
  Track,
} from "../../../src/scoring/domain/types";

const baseConfig: ScoringConfig = {
  weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
  thresholds: { apply: 70, review: 45 },
  trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
  minExtractedRequirements: 3,
  blockingCapScore: 35,
};

function requirement(
  weight: Requirement["weight"],
  text = "requirement",
): Requirement {
  return { text, category: "general", weight };
}

describe("computeTrackAlignment", () => {
  it("falls back to the unknown weight when no track matched", () => {
    expect(computeTrackAlignment([], baseConfig.trackWeights)).toBe(0.4);
  });

  it("uses the single matched track's weight", () => {
    expect(computeTrackAlignment(["automation"], baseConfig.trackWeights)).toBe(
      0.7,
    );
  });

  it("picks the highest weight across multiple matched tracks", () => {
    const tracks: Track[] = ["automation", "security"];
    expect(computeTrackAlignment(tracks, baseConfig.trackWeights)).toBe(1.0);
  });

  it("is order-independent when picking the highest weight", () => {
    expect(
      computeTrackAlignment(
        ["security", "automation"],
        baseConfig.trackWeights,
      ),
    ).toBe(
      computeTrackAlignment(
        ["automation", "security"],
        baseConfig.trackWeights,
      ),
    );
  });
});

describe("computeScore — coverage", () => {
  it("treats an empty mandatory category as full coverage (1)", () => {
    const outcome = computeScore([], ["dev"], baseConfig);
    expect(outcome.breakdown.mandatoryCoverage).toBe(1);
    expect(outcome.breakdown.desirableCoverage).toBe(1);
  });

  it("averages statusWeight across a mandatory category", () => {
    const matches = [
      createMatch(requirement("mandatory", "a"), "met", "evidence a"),
      createMatch(requirement("mandatory", "b"), "partial", "evidence b"),
      createMatch(requirement("mandatory", "c"), "not_met", null),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    // (1.0 + 0.5 + 0.0) / 3
    expect(outcome.breakdown.mandatoryCoverage).toBeCloseTo(0.5, 10);
  });

  it("only counts requirements of the matching weight in each coverage term", () => {
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.breakdown.mandatoryCoverage).toBe(1);
    expect(outcome.breakdown.desirableCoverage).toBe(0);
  });
});

describe("computeScore — blocking requirements", () => {
  it("caps the score at blockingCapScore when a blocking requirement is not_met", () => {
    const blocking = requirement("blocking", "period >= 3");
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.score).toBe(35);
    expect(outcome.blockingFailure).toEqual(blocking);
    expect(outcome.verdict).toBe("discard");
  });

  it("caps the score at blockingCapScore when a blocking requirement is only partial", () => {
    const blocking = requirement("blocking", "ATS knockout question");
    const matches = [
      createMatch(blocking, "partial", "ambiguous evidence"),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.score).toBe(35);
    expect(outcome.blockingFailure).toEqual(blocking);
  });

  it("does not raise a score that is already below the cap", () => {
    const blocking = requirement("blocking");
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "not_met", null),
      createMatch(requirement("desirable"), "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    // raw score = 65*0 + 20*0 + 15*0.4(unknown) = 6, below the 35 cap
    expect(outcome.score).toBeCloseTo(6, 10);
  });

  it("leaves blockingFailure null when the blocking requirement is met", () => {
    const matches = [createMatch(requirement("blocking"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.blockingFailure).toBeNull();
  });

  it("leaves blockingFailure null when there are no blocking requirements", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.blockingFailure).toBeNull();
  });
});

describe("computeScore — verdict boundaries", () => {
  it("is 'apply' at exactly the apply threshold (70)", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 70, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], config);
    expect(outcome.score).toBe(70);
    expect(outcome.verdict).toBe("apply");
  });

  it("is 'review' just below the apply threshold", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 69, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], config);
    expect(outcome.score).toBe(69);
    expect(outcome.verdict).toBe("review");
  });

  it("is 'review' at exactly the review threshold (45)", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 45, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], config);
    expect(outcome.score).toBe(45);
    expect(outcome.verdict).toBe("review");
  });

  it("is 'discard' just below the review threshold", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 44, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], config);
    expect(outcome.score).toBe(44);
    expect(outcome.verdict).toBe("discard");
  });
});

describe("computeScore — lowConfidence", () => {
  it("flags lowConfidence when fewer requirements were extracted than the minimum", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], {
      ...baseConfig,
      minExtractedRequirements: 3,
    });
    expect(outcome.lowConfidence).toBe(true);
  });

  it("does not flag lowConfidence when enough requirements were extracted", () => {
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("mandatory"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], {
      ...baseConfig,
      minExtractedRequirements: 3,
    });
    expect(outcome.lowConfidence).toBe(false);
  });

  it("caps an otherwise-apply verdict at review when lowConfidence — the empty-posting edge case", () => {
    // No requirements at all: empty-category coverage rule gives full marks,
    // which would otherwise top the ranking on a vague, contentless posting.
    const outcome = computeScore([], ["dev"], baseConfig);
    expect(outcome.score).toBe(100);
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.verdict).toBe("review");
  });

  it("never upgrades a discard verdict to review because of lowConfidence", () => {
    const matches = [createMatch(requirement("mandatory"), "not_met", null)];
    const outcome = computeScore(matches, [], {
      ...baseConfig,
      minExtractedRequirements: 5,
    });
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.verdict).toBe("discard");
  });
});

describe("computeScore — criticalGaps", () => {
  it("includes not_met mandatory and blocking requirements", () => {
    const mandatoryGap = requirement("mandatory", "SQL");
    const blockingGap = requirement("blocking", "period >= 3");
    const matches = [
      createMatch(mandatoryGap, "not_met", null),
      createMatch(blockingGap, "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([mandatoryGap, blockingGap]);
  });

  it("includes a partial mandatory requirement as a gap", () => {
    const partialGap = requirement("mandatory", "Docker");
    const matches = [createMatch(partialGap, "partial", "some evidence")];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([partialGap]);
  });

  it("excludes met requirements", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([]);
  });

  it("excludes not_met desirable requirements — they are not critical", () => {
    const matches = [createMatch(requirement("desirable"), "not_met", null)];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([]);
  });
});
