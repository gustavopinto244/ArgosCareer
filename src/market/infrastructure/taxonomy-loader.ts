import { readYamlFile } from "../../config/infrastructure/read-yaml-file";
import { Taxonomy, TaxonomySchema } from "../domain/taxonomy";

export class TaxonomyValidationError extends Error {
  constructor(
    filePath: string,
    issues: readonly { path: PropertyKey[]; message: string }[],
  ) {
    const details = issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    super(`Invalid taxonomy at ${filePath}:\n${details}`);
    this.name = "TaxonomyValidationError";
  }
}

/**
 * Reads, parses and validates `config/taxonomy.yaml` synchronously, failing
 * loudly at startup rather than silently aggregating over zero known
 * skills — same discipline `loadCriteria`/`loadProfile` already apply
 * (principle 3, `docs/09-configuration.md`).
 */
export function loadTaxonomy(filePath: string): Taxonomy {
  const parsed = readYamlFile(filePath);

  const result = TaxonomySchema.safeParse(parsed);
  if (!result.success) {
    throw new TaxonomyValidationError(filePath, result.error.issues);
  }

  return result.data;
}
