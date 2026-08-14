/**
 * Measures the pre-filter's real cut against the postings actually in the
 * database — not an estimate. Run after a real `collect` + `dedup` pass:
 *
 *   DATABASE_PATH=./data/argos.db npm run cli -- collect --job-name estágio --max-results 200
 *   DATABASE_PATH=./data/argos.db npm run cli -- dedup
 *   DATABASE_PATH=./data/argos.db npm run measure:prefilter
 *
 * Measured over active (non-duplicate) postings, matching the real pipeline
 * order — the pre-filter runs after dedup, not before
 * (docs/02-architecture.md).
 */
import {
  applyPreFilter,
  PreFilterRejectionReason,
} from "../src/prefilter/domain/pre-filter";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";

const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
const profilePath = process.env.PROFILE_PATH ?? "./config/profile.yaml";
const criteriaPath = process.env.CRITERIA_PATH ?? "./config/criteria.yaml";

const db = createDatabase(databasePath);
runMigrations(db);
const repository = new PostingsRepository(db);

const profile = loadProfile(profilePath);
const criteria = loadCriteria(criteriaPath);
const profileKeywords = profile.competencies.flatMap((c) => [
  c.name,
  ...c.aliases,
]);

const active = repository.findActive();
const now = new Date();

let passed = 0;
const rejections: Partial<Record<PreFilterRejectionReason, number>> = {};

for (const posting of active) {
  const outcome = applyPreFilter(posting, criteria, profileKeywords, now);
  if (outcome.passed) {
    passed += 1;
  } else if (outcome.reason) {
    rejections[outcome.reason] = (rejections[outcome.reason] ?? 0) + 1;
  }
}

const total = active.length;
const rejected = total - passed;
const cutPercent = total === 0 ? 0 : (100 * rejected) / total;

console.log(`Scanned ${total} active postings.`);
console.log(`Passed: ${passed} (${(100 - cutPercent).toFixed(1)}%)`);
console.log(`Rejected: ${rejected} (${cutPercent.toFixed(1)}%)`);
console.log("Rejection breakdown:");
for (const [reason, count] of Object.entries(rejections)) {
  console.log(`  ${reason}: ${count}`);
}
