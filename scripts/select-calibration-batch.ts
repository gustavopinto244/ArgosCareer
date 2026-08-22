/**
 * One-off helper for expanding the M7 calibration worksheet
 * (docs/04-scoring-model.md) to 50 postings without disturbing the 16
 * already hand-labelled entries in data/calibration/labels.yaml.
 *
 * Runs the real pre-filter against a given database (pass a snapshot via
 * DATABASE_PATH — production data never has to touch this machine's own
 * data/argos.db to build the worksheet), skips postings already present in
 * the existing worksheet, and appends new candidates — most recent first —
 * until the file holds TARGET_TOTAL entries. New entries get handScore:
 * null for hand-labelling; nothing here calls the LLM or guesses a score.
 *
 * Run: DATABASE_PATH=<path> npx tsx scripts/select-calibration-batch.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
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
const TARGET_TOTAL = 50;

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

  const existingRaw = readFileSync(OUTPUT_PATH, "utf8");
  const existing = parse(existingRaw) as Array<{
    fingerprint: string;
    handScore: number | null;
  }>;
  const existingFingerprints = new Set(existing.map((e) => e.fingerprint));

  const slotsAvailable = TARGET_TOTAL - existing.length;
  if (slotsAvailable <= 0) {
    console.log(
      `Worksheet already has ${existing.length} entries, target is ${TARGET_TOTAL}. Nothing to add.`,
    );
    return;
  }

  const passing = postingsRepo
    .findActive()
    .filter(
      (posting) =>
        !existingFingerprints.has(posting.fingerprint) &&
        applyPreFilter(posting, criteria, profileKeywords, now).passed,
    )
    // most recently seen first — the freshest read of "what does the
    // current corpus look like", not an arbitrary DB order
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  const chosen = passing.slice(0, slotsAvailable);

  const newEntries = chosen.map((posting) => ({
    fingerprint: posting.fingerprint,
    company: posting.company,
    title: posting.title,
    location:
      posting.location.kind === "known" ? posting.location.city : "unknown",
    workMode: posting.workMode,
    sourceUrl: posting.sourceUrl,
    description: posting.description,
    handScore: null,
    notes: "",
  }));

  const merged = [...existing, ...newEntries];
  writeFileSync(OUTPUT_PATH, stringify(merged), "utf8");

  console.log(
    `Pre-filter passing candidates available: ${passing.length}. Added ${newEntries.length}, worksheet now has ${merged.length} entries (${existing.length} already labelled, ${newEntries.length} blank).`,
  );
}

main();
