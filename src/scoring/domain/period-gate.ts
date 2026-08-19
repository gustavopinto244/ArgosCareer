import { AcademicPeriod } from "../../profile/domain/academic-period";
import { Requirement } from "./types";

/**
 * A minimum-academic-period requirement is real ("cursando a partir do 4º
 * período") but not a rejection the way any other unmet `blocking`
 * requirement is — the candidate will meet it later, on a knowable date.
 * Left as an ordinary blocking failure, it caps the score at
 * `blockingCapScore` and the posting reads as "you don't qualify," which
 * CLAUDE.md §9 says is the wrong framing: "That is planning information,
 * not a rejection." `digest.ts`'s `PeriodBlockedEntry` and
 * `render-digest.ts`'s "Abrem para você em breve" section existed for this
 * since M7 (docs/audit AC-026) but nothing ever populated them — Stage A
 * extracts the requirement text, Stage B matches it `not_met` like any
 * other, and nothing turned that specific text into a structured period
 * number to compare against `computeAcademicPeriod`. This is that step.
 *
 * Heuristic, not authoritative: this reads the LLM-extracted requirement
 * *text*, not a structured field the source actually provides (CIEE has
 * `semestreInicio`/`semestreFinal`, but only as free text folded into
 * `description` today — docs/11-known-issues.md). A phrasing this does not
 * recognize is not a false positive, only a missed one — the requirement
 * stays an ordinary blocking failure, exactly today's behavior. A
 * misidentified phrasing (this matches a period pattern that is not
 * actually a period gate) is the failure mode worth being conservative
 * about, so every pattern below requires an explicit trigger phrase
 * ("a partir do", "em diante", "exigido") next to the number, not a bare
 * "Nº período" anywhere in the text.
 */
const PERIOD_PATTERNS: readonly RegExp[] = [
  /a partir do\s*(\d{1,2})\s*[ºo°]?\s*per[ií]odo/i,
  /(\d{1,2})\s*[ºo°]?\s*per[ií]odos?\s*em diante/i,
  /a partir do\s*(\d{1,2})\s*[ºo°]?\s*semestre/i,
  /semestre\s*exigido\s*:?\s*(\d{1,2})/i,
];

/** `null` when the text does not match a recognized period-gate phrasing.
 * A parsed number outside [1, 8] is treated the same as no match — outside
 * this course's real semester range (`computeAcademicPeriod`'s own clamp),
 * so trusting it would produce a nonsensical "opens at" date rather than a
 * useful one. */
export function extractMinimumPeriod(text: string): number | null {
  for (const pattern of PERIOD_PATTERNS) {
    const match = pattern.exec(text);
    const captured = match?.[1];
    if (captured) {
      const value = Number.parseInt(captured, 10);
      if (value >= 1 && value <= 8) return value;
    }
  }
  return null;
}

export interface PeriodGate {
  readonly minimumPeriod: number;
  readonly opensAtLabel: string;
}

/**
 * Populated only when a period gate is the entire story: exactly one
 * unmet `blocking` requirement among `blockingFailures`, it parses as a
 * period gate, and the candidate has not reached it yet. A posting with
 * *any other* unmet blocking requirement alongside the period one is a
 * real rejection independent of timing — reclassifying it as "opens
 * later" would hide the other reason it is not a fit. `currentPeriod`
 * comes from the caller (`computeAcademicPeriod`, already computed once
 * per run) rather than recomputed here, so this stays a pure function of
 * its arguments like the rest of Stage C.
 */
export function detectPeriodGate(
  blockingFailures: readonly Requirement[],
  currentPeriod: AcademicPeriod,
  opensAtLabel: (minimumPeriod: number) => string,
): PeriodGate | null {
  const onlyFailure =
    blockingFailures.length === 1 ? blockingFailures[0] : undefined;
  if (!onlyFailure) return null;

  const minimumPeriod = extractMinimumPeriod(onlyFailure.text);
  if (minimumPeriod === null) return null;

  const reached =
    currentPeriod.status === "in_progress" &&
    currentPeriod.period >= minimumPeriod;
  if (reached || currentPeriod.status === "completed") return null;

  return { minimumPeriod, opensAtLabel: opensAtLabel(minimumPeriod) };
}
