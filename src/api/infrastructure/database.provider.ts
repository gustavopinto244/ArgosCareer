import { FactoryProvider } from "@nestjs/common";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../persistence/infrastructure/db";

/**
 * A separate connection from `SchedulerService`'s (`src/scheduling/infrastructure`)
 * — both point at the same file, safe under the `journal_mode = WAL` every
 * connection opens with (`db.ts`), and keeping them independent means the
 * HTTP layer and the scheduler have no shared mutable state to coordinate,
 * consistent with `RunsRepository` already being constructed fresh per call
 * rather than held as a singleton.
 */
export const DATABASE = Symbol("DATABASE");

export const databaseProvider: FactoryProvider<Db> = {
  provide: DATABASE,
  useFactory: (): Db => {
    const db = createDatabase(process.env.DATABASE_PATH ?? "./data/argos.db");
    runMigrations(db);
    return db;
  },
};
