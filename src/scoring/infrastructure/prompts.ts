import { readFileSync } from "node:fs";
import { computeAcademicPeriod } from "../../profile/domain/academic-period";
import { Profile } from "../../profile/domain/profile";
import { Requirement } from "../domain/types";

/**
 * The prompt version is the file it came from, not a separately maintained
 * string — a wording change means a new file (`a-v2`), so the version and
 * the content it names can never drift apart (see `prompts/*.v1.md`'s note).
 */
export const STAGE_A_PROMPT_VERSION = "a-v3";
export const STAGE_A_PROMPT_PATH = "./prompts/stage-a-extraction.v3.md";

export const STAGE_B_PROMPT_VERSION = "b-v2";
export const STAGE_B_PROMPT_PATH = "./prompts/stage-b-matching.v2.md";

/**
 * The prompt files are Markdown documentation with one fenced code block
 * holding the actual template — everything above and below the fence is
 * commentary for a human reader, not sent to the model.
 */
function loadTemplate(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  const match = /```\n([\s\S]*?)\n```/.exec(content);
  if (!match?.[1]) {
    throw new Error(`No fenced template block found in ${filePath}`);
  }
  return match[1];
}

function substitute(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}

export function buildStageAPrompt(
  title: string,
  description: string | null,
  promptPath: string = STAGE_A_PROMPT_PATH,
): string {
  const template = loadTemplate(promptPath);
  return substitute(template, {
    POSTING_TITLE: title,
    POSTING_DESCRIPTION: description ?? "(not provided)",
  });
}

/**
 * The academic-enrollment facts, rendered as one more quotable evidence line.
 *
 * Derived from `courseStart` via `computeAcademicPeriod`, never written down
 * as a period number (CLAUDE.md §9: "a hardcoded period silently ages into a
 * lie"). Postings ask "cursando a partir do 3º período" constantly, and
 * before this existed the profile had no quotable text saying which period
 * the candidate is in, so stage B answered `not_met` on every one of them —
 * usually a `blocking` requirement, capping the score (ADR-014).
 *
 * Caveat worth knowing: this text changes at each semester boundary while
 * `profileHash` does not, so cached stage B matches keep the period that was
 * current when they were written. Twice a year, cached matches are stale in
 * this one field until the profile or the prompt version changes.
 */
function formatAcademicEvidence(profile: Profile, today: Date): string[] {
  const period = computeAcademicPeriod(profile.courseStart, today);
  const completion = `${profile.courseEnd.getUTCFullYear()}.${profile.courseEnd.getUTCMonth() + 1 >= 7 ? 2 : 1}`;
  const course = `${profile.courseName} na ${profile.institution}`;

  switch (period.status) {
    case "not_started":
      return [
        `- [Academic enrollment] Ingressa em ${course} e ainda não iniciou o curso; conclusão prevista para ${completion}.`,
      ];
    case "completed":
      return [`- [Academic enrollment] Concluiu ${course}.`];
    case "in_progress":
      return [
        `- [Academic enrollment] Cursando o ${period.period}º período de ${course}, com conclusão prevista para ${completion}.`,
      ];
  }
}

/**
 * Every competency's evidence, verbatim, tagged by competency name, plus the
 * derived academic-enrollment line — the only text stage B's "evidence"
 * field may legally quote from (ADR-005).
 */
function formatProfileEvidence(profile: Profile, today: Date): string {
  return [
    ...formatAcademicEvidence(profile, today),
    ...profile.competencies.flatMap((competency) =>
      competency.evidence.map((line) => `- [${competency.name}] ${line}`),
    ),
  ].join("\n");
}

export function buildStageBPrompt(
  requirement: Requirement,
  profile: Profile,
  promptPath: string = STAGE_B_PROMPT_PATH,
  today: Date = new Date(),
): string {
  const template = loadTemplate(promptPath);
  return substitute(template, {
    REQUIREMENT_TEXT: requirement.text,
    REQUIREMENT_CATEGORY: requirement.category,
    REQUIREMENT_WEIGHT: requirement.weight,
    PROFILE_EVIDENCE: formatProfileEvidence(profile, today),
  });
}
