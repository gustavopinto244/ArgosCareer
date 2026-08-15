/**
 * VACUUM INTOs the configured database to a timestamped file, prunes
 * anything past the retention count. Run standalone: npm run backup
 * (also runs on a schedule from within the app, M8).
 */
import { backupDatabase } from "../src/persistence/infrastructure/backup";

const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
const backupsDir = process.env.BACKUPS_DIR ?? "./backups";
const retention = process.env.BACKUP_RETENTION
  ? Number(process.env.BACKUP_RETENTION)
  : 7;

const result = backupDatabase(
  databasePath,
  backupsDir,
  () => new Date(),
  retention,
);
console.log(`Backed up ${databasePath} -> ${result.path}`);
if (result.deletedOldBackups.length > 0) {
  console.log(
    `Pruned ${result.deletedOldBackups.length} backup(s) past retention (${retention}): ${result.deletedOldBackups.join(", ")}`,
  );
}
