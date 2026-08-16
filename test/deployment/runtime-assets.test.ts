import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the one mistake this project has now made three times: a directory
 * the runtime reads at execution time exists in the repository, is loaded by
 * a relative path in `src/`, and is not in the container image.
 *
 * - M10: `config/taxonomy.yaml` had no `COPY` — the container crash-looped on
 *   first deploy, caught immediately because it happened at boot.
 * - M8:  `prompts/` was listed in `.dockerignore` — invisible for a month,
 *   because prompts are only read once a posting survives the pre-filter, and
 *   until 2026-08-16 none ever had. The nightly cycle threw at 03:00 and no
 *   digest went out.
 *
 * The difference between those two is only *when* the read happens, which is
 * luck, not design. So this asserts the packaging directly rather than
 * trusting that the next missing asset will fail loudly at boot.
 *
 * Deliberately parses the real `Dockerfile` and `.dockerignore` instead of
 * building an image: a `docker build` in CI would catch strictly more, and
 * cost minutes per run to catch a class of bug that is a one-line text check.
 */
const ROOT = resolve(__dirname, "../..");

/** Directories `src/` reads from disk at runtime, by relative path. */
const RUNTIME_ASSET_DIRS = ["config", "drizzle", "prompts"] as const;

function read(name: string): string {
  return readFileSync(resolve(ROOT, name), "utf8");
}

/** Non-empty, non-comment lines — `.dockerignore` comment syntax is `#`. */
function dockerignorePatterns(): string[] {
  return read(".dockerignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("runtime assets are packaged into the image", () => {
  it.each(RUNTIME_ASSET_DIRS)("%s is not excluded by .dockerignore", (dir) => {
    // A bare directory name excludes the whole tree from the build context,
    // which is how `prompts` disappeared. A pattern *inside* the directory
    // (`config/profile.yaml`) is legitimate and deliberately still allowed.
    expect(dockerignorePatterns()).not.toContain(dir);
    expect(dockerignorePatterns()).not.toContain(`${dir}/`);
  });

  it.each(RUNTIME_ASSET_DIRS)("%s is COPYed by the Dockerfile", (dir) => {
    const copiesDir = new RegExp(`^COPY\\s+${dir}/?\\s`, "m");
    expect(read("Dockerfile")).toMatch(copiesDir);
  });

  it.each(RUNTIME_ASSET_DIRS)("%s exists in the repository", (dir) => {
    expect(existsSync(resolve(ROOT, dir))).toBe(true);
  });
});
