import { readFileSync } from "node:fs";
import { Profile } from "../../profile/domain/profile";
import { Requirement } from "../domain/types";

/**
 * The prompt version is the file it came from, not a separately maintained
 * string — a wording change means a new file (`a-v2`), so the version and
 * the content it names can never drift apart (see `prompts/*.v1.md`'s note).
 */
export const STAGE_A_PROMPT_VERSION = "a-v1";
export const STAGE_A_PROMPT_PATH = "./prompts/stage-a-extraction.v1.md";

export const STAGE_B_PROMPT_VERSION = "b-v1";
export const STAGE_B_PROMPT_PATH = "./prompts/stage-b-matching.v1.md";

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
 * Every competency's evidence, verbatim, tagged by competency name — the
 * only text stage B's "evidence" field may legally quote from (ADR-005).
 */
function formatProfileEvidence(profile: Profile): string {
  return profile.competencies
    .flatMap((competency) =>
      competency.evidence.map((line) => `- [${competency.name}] ${line}`),
    )
    .join("\n");
}

export function buildStageBPrompt(
  requirement: Requirement,
  profile: Profile,
  promptPath: string = STAGE_B_PROMPT_PATH,
): string {
  const template = loadTemplate(promptPath);
  return substitute(template, {
    REQUIREMENT_TEXT: requirement.text,
    REQUIREMENT_CATEGORY: requirement.category,
    REQUIREMENT_WEIGHT: requirement.weight,
    PROFILE_EVIDENCE: formatProfileEvidence(profile),
  });
}
