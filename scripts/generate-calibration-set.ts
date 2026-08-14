/**
 * Generates the hand-labeling worksheet for the M7 calibration protocol
 * (docs/04-scoring-model.md): every real, currently-active posting that
 * passes the pre-filter, with a blank `handScore` for me to fill in by hand
 * — before looking at any model output, to avoid anchoring.
 *
 * Output is personal (which real postings matched my search, and my own
 * judgment of them) and lands under data/, already gitignored wholesale.
 *
 * Run: npm run calibration:generate
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { stringify } from "yaml";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { deriveProfileKeywords } from "../src/profile/domain/profile-keywords";
import { applyPreFilter } from "../src/prefilter/domain/pre-filter";

const OUTPUT_PATH = "./data/calibration/labels.yaml";

function main(): void {
  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const db = createDatabase(databasePath);
  runMigrations(db);

  const postingsRepo = new PostingsRepository(db);
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const profileKeywords = deriveProfileKeywords(profile);
  const now = new Date();

  const passing = postingsRepo
    .findActive()
    .filter(
      (posting) =>
        applyPreFilter(posting, criteria, profileKeywords, now).passed,
    );

  const worksheet = passing.map((posting) => ({
    fingerprint: posting.fingerprint,
    company: posting.company,
    title: posting.title,
    location:
      posting.location.kind === "known" ? posting.location.city : "unknown",
    workMode: posting.workMode,
    sourceUrl: posting.sourceUrl,
    description: posting.description,
    // Fill in 0-100: the score you would give this posting, before looking
    // at any model output (docs/04-scoring-model.md's calibration protocol,
    // step 1). Leave null to skip a posting you can't judge.
    handScore: null,
    notes: "",
  }));

  mkdirSync("./data/calibration", { recursive: true });
  writeFileSync(OUTPUT_PATH, stringify(worksheet), "utf8");

  console.log(
    `Wrote ${worksheet.length} pre-filter-passing postings to ${OUTPUT_PATH}`,
  );
  console.log(
    "Fill in handScore (0-100) for each, then run the calibration script.",
  );
}

main();
