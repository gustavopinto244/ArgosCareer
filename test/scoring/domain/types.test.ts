import { describe, expect, it } from "vitest";
import { scoreFailureOutcome } from "../../../src/scoring/domain/types";

describe("scoreFailureOutcome (docs/audit AC-009)", () => {
  it("sets score to 0 and verdict to review", () => {
    const outcome = scoreFailureOutcome("extraction_failed");
    expect(outcome.score).toBe(0);
    expect(outcome.verdict).toBe("review");
  });

  it("sets lowConfidence, matching the treatment of any posting nothing could be judged on", () => {
    const outcome = scoreFailureOutcome("matching_failed");
    expect(outcome.lowConfidence).toBe(true);
  });

  it("carries the failure reason through unchanged", () => {
    expect(scoreFailureOutcome("invalid_output").scoreFailureReason).toBe(
      "invalid_output",
    );
  });

  it("reports no blocking failure and no critical gaps — nothing was actually evaluated", () => {
    const outcome = scoreFailureOutcome("extraction_failed");
    expect(outcome.blockingFailure).toBeNull();
    expect(outcome.criticalGaps).toEqual([]);
  });
});
