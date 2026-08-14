import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Reads and parses a YAML config file, naming the file path on either
 * failure. Shared by every config loader (profile, criteria, …) — the
 * schema validation and error type stay specific to each caller, since
 * "invalid profile" and "invalid criteria" are different failures worth
 * telling apart in a log, but reading a file off disk is not.
 */
export function readYamlFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read config file at ${filePath}`, { cause });
  }

  try {
    return parseYaml(raw);
  } catch (cause) {
    throw new Error(`Cannot parse config YAML at ${filePath}`, { cause });
  }
}
