import { readFileSync } from "node:fs";
import { computeAcademicPeriod } from "../../profile/domain/academic-period";
import { Profile, UNVERIFIED } from "../../profile/domain/profile";
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

/**
 * Reads both templates once, up front, and reports the first that cannot be
 * loaded — a missing file, or a file with no fenced block.
 *
 * Exists because a prompt template is a *deployment* fact, not a per-posting
 * one: if `stage-a-extraction.v3.md` is absent, it is absent for all 2292
 * postings, and discovering that per posting turns one packaging mistake into
 * a batch of identical failures. `buildScorer` calls this so the condition
 * surfaces as the misconfiguration it is, on the same path that already
 * reports a missing LLM_API_KEY, instead of as a stack trace at 03:00.
 *
 * Returns the message rather than throwing, matching `BuildScorerResult` —
 * the caller decides whether that becomes a console line or a Telegram alert.
 */
export function verifyPromptTemplates(
  paths: readonly string[] = [STAGE_A_PROMPT_PATH, STAGE_B_PROMPT_PATH],
): string | null {
  for (const path of paths) {
    try {
      loadTemplate(path);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `Prompt template unavailable: ${detail}`;
    }
  }
  return null;
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
 * `englishLevel` and `maxWeeklyHours`/`minimumStipend` (CLAUDE.md §9) as
 * quotable lines. These fields existed on `Profile` since M2 but were never
 * rendered into stage B's evidence — the same class of gap
 * `formatAcademicEvidence` closed for enrollment (ADR-014). "Inglês
 * intermediário" and availability/schedule requirements are common enough
 * that leaving them unrendered meant every posting asking for either scored
 * `not_met` regardless of the actual answer once one was given.
 *
 * A field still `UNVERIFIED` (CLAUDE.md's placeholder for "not answered yet")
 * is skipped rather than rendered — quoting "⚠ VERIFY" back as if it were an
 * answer would be worse than the field staying absent.
 */
function formatDeclaredFieldsEvidence(profile: Profile): string[] {
  const lines: string[] = [];
  if (profile.englishLevel !== UNVERIFIED) {
    lines.push(`- [English level] Nível de inglês: ${profile.englishLevel}.`);
  }
  if (profile.maxWeeklyHours !== UNVERIFIED) {
    lines.push(
      `- [Availability] Disponibilidade de até ${profile.maxWeeklyHours} horas semanais.`,
    );
  }
  if (profile.minimumStipend !== UNVERIFIED) {
    lines.push(
      `- [Compensation] Bolsa-auxílio mínima aceita: ${profile.minimumStipend}.`,
    );
  }
  return lines;
}

/**
 * Every competency's evidence, verbatim, tagged by competency name, plus the
 * derived academic-enrollment and declared-field lines — the only text
 * stage B's "evidence" field may legally quote from (ADR-005).
 */
function formatProfileEvidence(profile: Profile, today: Date): string {
  return [
    ...formatAcademicEvidence(profile, today),
    ...formatDeclaredFieldsEvidence(profile),
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
