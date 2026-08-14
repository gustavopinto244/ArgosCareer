import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Profile, ProfileSchema } from "../domain/profile";

/**
 * Thrown when `config/profile.yaml` parses as YAML but fails schema
 * validation. The message lists every failing field's path — the file is
 * gitignored and personal, so a bare "invalid profile" would send whoever
 * hits this back into a file they cannot show anyone for help.
 */
export class ProfileValidationError extends Error {
  constructor(
    filePath: string,
    issues: readonly { path: PropertyKey[]; message: string }[],
  ) {
    const details = issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    super(`Invalid profile at ${filePath}:\n${details}`);
    this.name = "ProfileValidationError";
  }
}

/**
 * Reads, parses and validates `config/profile.yaml` synchronously. Config is
 * read once at startup (docs/09-configuration.md), so a blocking read here is
 * the point: the process should not start at all with an invalid profile,
 * not fail confusingly three stages later.
 *
 * Every failure names the file path; a schema failure also names the exact
 * field (principle 3's "fail loudly at startup" requirement).
 */
export function loadProfile(filePath: string): Profile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read profile file at ${filePath}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new Error(`Cannot parse profile YAML at ${filePath}`, { cause });
  }

  const result = ProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProfileValidationError(filePath, result.error.issues);
  }

  return result.data;
}
