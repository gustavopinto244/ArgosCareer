/**
 * Counts academic semester boundaries, not elapsed months
 * (docs/02-architecture.md). In the Brazilian calendar the first semester
 * starts around March and the second around August, so naive month
 * arithmetic gets March→August (5 months) wrong: it reads as period 1 when
 * the second semester has already started.
 *
 * `month` is converted to 1-indexed before the `>= 7` comparison, matching
 * the documented formula literally instead of writing the equivalent
 * 0-indexed `>= 6` against `Date.getMonth()` directly — the off-by-one trap
 * the docs warn about is a mistake available only to the second form.
 *
 * Uses the UTC getters, not the local ones. `Date#getMonth` reads the
 * process's local timezone, so the same course-start date would silently
 * compute a different period depending on whether the process runs as
 * America/Sao_Paulo or as UTC — the default in most Docker base images, and
 * M8 deploys this in a container. The calendar date must decide the period,
 * never the deployment's timezone configuration.
 */
function absoluteSemesterIndex(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return year * 2 + (month >= 7 ? 1 : 0);
}

export type AcademicPeriod =
  | { readonly status: "not_started" }
  | { readonly status: "in_progress"; readonly period: number }
  | { readonly status: "completed" };

/**
 * `period` is clamped to [1, 8] by construction: below 1 is "not_started",
 * above 8 is "completed" — a raw number outside that range would be a silent
 * lie about which internships are actually reachable.
 */
export function computeAcademicPeriod(
  courseStart: Date,
  today: Date,
): AcademicPeriod {
  const rawPeriod =
    absoluteSemesterIndex(today) - absoluteSemesterIndex(courseStart) + 1;

  if (rawPeriod < 1) return { status: "not_started" };
  if (rawPeriod > 8) return { status: "completed" };
  return { status: "in_progress", period: rawPeriod };
}
