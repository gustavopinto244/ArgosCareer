import { describe, expect, it } from "vitest";
import { computeAcademicPeriod } from "../../../src/profile/domain/academic-period";

const courseStart = new Date("2026-03-01T00:00:00Z");

describe("computeAcademicPeriod", () => {
  it("is period 1 at the course start itself", () => {
    const result = computeAcademicPeriod(courseStart, courseStart);
    expect(result).toEqual({ status: "in_progress", period: 1 });
  });

  it("is period 2 in August 2026 — the mandated checkpoint", () => {
    const today = new Date("2026-08-14T00:00:00Z");
    const result = computeAcademicPeriod(courseStart, today);
    expect(result).toEqual({ status: "in_progress", period: 2 });
  });

  it("is period 3 in March 2027 — the mandated checkpoint", () => {
    const today = new Date("2027-03-01T00:00:00Z");
    const result = computeAcademicPeriod(courseStart, today);
    expect(result).toEqual({ status: "in_progress", period: 3 });
  });

  it("moves to period 2 exactly at the July boundary, not August — the off-by-one trap", () => {
    // A naive port of the 0-indexed getMonth() >= 6 rule as `>= 7` without
    // adjusting for indexing would push this boundary to August instead.
    const june = computeAcademicPeriod(
      courseStart,
      new Date("2026-06-30T00:00:00Z"),
    );
    const july = computeAcademicPeriod(
      courseStart,
      new Date("2026-07-01T00:00:00Z"),
    );
    expect(june).toEqual({ status: "in_progress", period: 1 });
    expect(july).toEqual({ status: "in_progress", period: 2 });
  });

  it("is in_progress at period 1 for any date in the same semester as the start, even before the exact day", () => {
    // The formula has semester granularity, not day granularity — January
    // 2026 is the same semester as the March 2026 start date.
    const result = computeAcademicPeriod(
      courseStart,
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "in_progress", period: 1 });
  });

  it("is not_started in the semester immediately before the course starts", () => {
    const result = computeAcademicPeriod(
      courseStart,
      new Date("2025-08-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "not_started" });
  });

  it("is completed past period 8", () => {
    // 8 periods from March 2026 (period 1) ends at period 8 in the second
    // semester of 2029; the semester after that is period 9, i.e. completed.
    const result = computeAcademicPeriod(
      courseStart,
      new Date("2030-03-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "completed" });
  });

  it("is still in_progress at exactly period 8", () => {
    const result = computeAcademicPeriod(
      courseStart,
      new Date("2029-08-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "in_progress", period: 8 });
  });
});
