/**
 * Applies pending migrations to the configured database, creating it if it
 * does not exist. Run: npm run db:migrate
 */
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";

const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
const db = createDatabase(databasePath);
runMigrations(db);
console.log(`Migrated ${databasePath}`);
