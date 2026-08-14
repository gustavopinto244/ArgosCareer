import { readYamlFile } from "../../config/infrastructure/read-yaml-file";
import { Criteria, CriteriaSchema } from "../domain/criteria";

export class CriteriaValidationError extends Error {
  constructor(
    filePath: string,
    issues: readonly { path: PropertyKey[]; message: string }[],
  ) {
    const details = issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    super(`Invalid criteria at ${filePath}:\n${details}`);
    this.name = "CriteriaValidationError";
  }
}

/**
 * Reads, parses and validates `config/criteria.yaml` synchronously, failing
 * loudly at startup rather than producing an empty filter that silently
 * passes everything (principle 3, docs/09-configuration.md).
 */
export function loadCriteria(filePath: string): Criteria {
  const parsed = readYamlFile(filePath);

  const result = CriteriaSchema.safeParse(parsed);
  if (!result.success) {
    throw new CriteriaValidationError(filePath, result.error.issues);
  }

  return result.data;
}
