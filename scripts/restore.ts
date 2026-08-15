/**
 * Restores the configured database from a backup file. Refuses if the live
 * database looks mid-run. Run: npm run restore -- <path-to-backup.db>
 */
import { restoreDatabase } from "../src/persistence/infrastructure/restore";

const backupPath = process.argv[2];
if (!backupPath) {
  console.error("Usage: npm run restore -- <path-to-backup.db>");
  process.exitCode = 1;
} else {
  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const result = restoreDatabase(backupPath, databasePath);

  if (!result.ok) {
    console.error(`restore failed: ${result.error}`);
    process.exitCode = 1;
  } else {
    console.log(`Restored ${databasePath} from ${backupPath}`);
  }
}
